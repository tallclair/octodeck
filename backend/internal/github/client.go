package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
	graphql "github.com/cli/shurcooL-graphql"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

const (
	// searchPageSize is the number of items to fetch in a single GraphQL `search` page.
	// Kept low to avoid hitting GitHub API GraphQL query complexity limits or 502 Bad Gateway timeouts.
	searchPageSize = 10

	// nodeBatchSize is the number of items to fetch in a single GraphQL `nodes` query.
	// This is kept below the GitHub API's complexity limits.
	nodeBatchSize = 50

	// maxNotificationPages is the safety cap on pagination when querying GET /notifications.
	maxNotificationPages = 5
	// maxNotificationThreads is the safety limit on total notification threads ingested in one run.
	maxNotificationThreads = 250
	// notificationsPerPage is the per_page query param for GET /notifications.
	notificationsPerPage = 50
	// defaultGitHubAPIBase is the default base URL for GitHub REST API calls.
	defaultGitHubAPIBase = "https://api.github.com"

	// expectedSubjectURLMatches is the expected number of capture groups in subjectURLRegex.
	expectedSubjectURLMatches = 5
	// itemTargetSubmatchCount is the expected number of capture groups in itemTargetRegex.
	itemTargetSubmatchCount = 4
	// minLinkSectionParts is the minimum number of semicolon-separated sections in a Link header entry.
	minLinkSectionParts = 2

	// resolveNodeIDsBatchSize is the number of items to resolve in a single aliased GraphQL query.
	resolveNodeIDsBatchSize = 30

	// typePullRequest is the GraphQL typename for a Pull Request.
	typePullRequest = "PullRequest"
	// typeIssue is the GraphQL typename for an Issue.
	typeIssue = "Issue"

	// typeClosedEvent is the GraphQL typename for ClosedEvent.
	typeClosedEvent = "ClosedEvent"
	// typeMergedEvent is the GraphQL typename for MergedEvent.
	typeMergedEvent = "MergedEvent"
	// typeReopenedEvent is the GraphQL typename for ReopenedEvent.
	typeReopenedEvent = "ReopenedEvent"
	// typeAssignedEvent is the GraphQL typename for AssignedEvent.
	typeAssignedEvent = "AssignedEvent"

	// subscriptionSubscribed is the GraphQL viewerSubscription value for subscribed items.
	subscriptionSubscribed = "SUBSCRIBED"
	// subscriptionUnsubscribed is the GraphQL viewerSubscription value for unsubscribed items.
	subscriptionUnsubscribed = "UNSUBSCRIBED"
	// subscriptionIgnored is the GraphQL viewerSubscription value for ignored items.
	subscriptionIgnored = "IGNORED"

	// stateClosed is the GitHub issue/PR state for closed items.
	stateClosed = "CLOSED"
	// stateMerged is the GitHub pull request state for merged items.
	stateMerged = "MERGED"
)

// HTTPClient defines the interface for executing HTTP requests.
type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// RESTClient defines the interface we need from go-gh/api.
type RESTClient interface {
	DoWithContext(ctx context.Context, method string, path string, body io.Reader, response any) error
}

// GraphQLClient defines the interface we need from go-gh/api.
type GraphQLClient interface {
	QueryWithContext(ctx context.Context, name string, q any, vars map[string]any) error
}

// Client wraps the GitHub API client.
type Client struct {
	RestClient    RESTClient
	GraphQLClient GraphQLClient
	HTTPClient    HTTPClient
	CurrentUser   string
}

// NewClient creates a new GitHub client using default gh auth.
func NewClient() (*Client, error) {
	rest, err := api.DefaultRESTClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create default REST client: %w", err)
	}
	gql, err := api.DefaultGraphQLClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create default GraphQL client: %w", err)
	}
	httpClient, err := api.DefaultHTTPClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create default HTTP client: %w", err)
	}
	return &Client{RestClient: rest, GraphQLClient: gql, HTTPClient: httpClient}, nil
}

// SetCurrentUser sets the authenticated user login for the client.
func (c *Client) SetCurrentUser(login string) {
	if c != nil {
		c.CurrentUser = login
	}
}

// CheckAuth verifies if the client is authenticated with GitHub.
func (c *Client) CheckAuth(ctx context.Context) (string, bool, error) {
	if c == nil || c.RestClient == nil {
		return "", false, errors.New("github rest client is not initialized")
	}
	var user struct {
		Login string `json:"login"`
	}
	err := c.RestClient.DoWithContext(ctx, "GET", "user", nil, &user)
	if err != nil {
		return "", false, fmt.Errorf("authentication check failed: %w", err)
	}
	c.CurrentUser = user.Login
	return user.Login, true, nil
}

// ItemTarget identifies a repository issue or pull request to resolve.
type ItemTarget struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Number int32  `json:"number"`
}

// Key returns the string identifier "owner/repo#number".
func (t ItemTarget) Key() string {
	return fmt.Sprintf("%s/%s#%d", t.Owner, t.Repo, t.Number)
}

var itemTargetRegex = regexp.MustCompile(`^([^/#]+)/([^/#]+)#(\d+)$`)

// ParseItemTarget parses a target string of the form "owner/repo#number".
func ParseItemTarget(target string) (ItemTarget, error) {
	trimmed := strings.TrimSpace(target)
	matches := itemTargetRegex.FindStringSubmatch(trimmed)
	if len(matches) != itemTargetSubmatchCount {
		return ItemTarget{}, fmt.Errorf("invalid item target %q (expected format owner/repo#number)", target)
	}
	num, err := strconv.ParseInt(matches[3], 10, 32)
	if err != nil {
		return ItemTarget{}, fmt.Errorf("invalid item number in %q: %w", target, err)
	}
	return ItemTarget{
		Owner:  matches[1],
		Repo:   matches[2],
		Number: int32(num),
	}, nil
}

// ResolveNodeIDs resolves GraphQL Node IDs for repository issues and pull requests in batches
// (up to 30 items per query) using lightweight aliased GraphQL queries.
// Missing/null nodes are omitted without failing the entire batch.
func (c *Client) ResolveNodeIDs(ctx context.Context, targets []ItemTarget) (map[ItemTarget]string, error) {
	if len(targets) == 0 {
		return make(map[ItemTarget]string), nil
	}
	if c == nil || c.HTTPClient == nil {
		return nil, errors.New("github http client is not initialized")
	}

	result := make(map[ItemTarget]string, len(targets))

	for i := 0; i < len(targets); i += resolveNodeIDsBatchSize {
		end := min(i+resolveNodeIDsBatchSize, len(targets))
		batch := targets[i:end]

		batchMap, err := c.resolveNodeIDsBatch(ctx, batch)
		if err != nil {
			return nil, err
		}
		maps.Copy(result, batchMap)
	}

	return result, nil
}

type resolveGQLResponse struct {
	Data map[string]*struct {
		IssueOrPullRequest *struct {
			ID string `json:"id"`
		} `json:"issueOrPullRequest"`
	} `json:"data"`
	Errors []struct {
		Message string   `json:"message"`
		Type    string   `json:"type"`
		Path    []string `json:"path"`
	} `json:"errors"`
}

func (c *Client) resolveNodeIDsBatch(ctx context.Context, batch []ItemTarget) (map[ItemTarget]string, error) {
	var sb strings.Builder
	sb.WriteString("query ResolveNodeIDs {\n")
	for idx, t := range batch {
		fmt.Fprintf(&sb, "  q%d: repository(owner: %q, name: %q) {\n", idx, t.Owner, t.Repo)
		fmt.Fprintf(&sb, "    issueOrPullRequest(number: %d) {\n", t.Number)
		sb.WriteString("      ... on Issue { id }\n")
		sb.WriteString("      ... on PullRequest { id }\n")
		sb.WriteString("    }\n")
		sb.WriteString("  }\n")
	}
	sb.WriteString("}\n")

	reqBodyMap := map[string]string{
		"query": sb.String(), //nolint:goconst // GraphQL query parameter name
	}
	reqBytes, err := json.Marshal(reqBodyMap)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal GraphQL request: %w", err)
	}

	reqURL := fmt.Sprintf("%s/graphql", defaultGitHubAPIBase)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(reqBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create resolve-ids request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-Github-Api-Version", "2022-11-28")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("resolve-ids request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read resolve-ids response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("resolve-ids request returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var gqlResp resolveGQLResponse
	if err := json.Unmarshal(bodyBytes, &gqlResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal resolve-ids response: %w", err)
	}

	batchResult := make(map[ItemTarget]string)
	if gqlResp.Data != nil {
		for idx, t := range batch {
			alias := fmt.Sprintf("q%d", idx)
			repoNode := gqlResp.Data[alias]
			if repoNode != nil && repoNode.IssueOrPullRequest != nil && repoNode.IssueOrPullRequest.ID != "" {
				batchResult[t] = repoNode.IssueOrPullRequest.ID
			}
		}
	}

	if len(gqlResp.Errors) > 0 {
		slog.DebugContext(ctx, "Partial errors resolving node IDs", "errors_count", len(gqlResp.Errors))
	}

	return batchResult, nil
}

// NotificationThread represents a single notification thread from GitHub GET /notifications.
type NotificationThread struct {
	ID         string              `json:"id"`
	Unread     bool                `json:"unread"`
	Reason     string              `json:"reason"`
	UpdatedAt  string              `json:"updated_at"`
	LastReadAt string              `json:"last_read_at"`
	Subject    NotificationSubject `json:"subject"`
	Repository NotificationRepo    `json:"repository"`
	URL        string              `json:"url"`
}

// NotificationSubject describes the subject of a notification (Issue, PullRequest, Release, etc.).
type NotificationSubject struct {
	Title            string `json:"title"`
	URL              string `json:"url"`
	LatestCommentURL string `json:"latest_comment_url"`
	Type             string `json:"type"`
}

// NotificationRepo contains minimal repository metadata associated with a notification thread.
type NotificationRepo struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	FullName string `json:"full_name"`
}

var subjectURLRegex = regexp.MustCompile(`^https://api\.github\.com/repos/([^/]+)/([^/]+)/(pulls|issues)/(\d+)$`)

// ParseSubjectURL extracts repository owner, repo name, item number, and item type
// from GitHub API subject URLs (e.g. https://api.github.com/repos/owner/repo/pulls/123).
// Returns an error for empty URLs or non-issue/PR notification types.
func ParseSubjectURL(apiURL string) (owner, repo string, number int32, itemType octodeckv1.ItemType, err error) {
	if apiURL == "" {
		return "", "", 0, octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED, errors.New("empty subject URL")
	}

	matches := subjectURLRegex.FindStringSubmatch(apiURL)
	if len(matches) != expectedSubjectURLMatches {
		return "", "", 0, octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			fmt.Errorf("unsupported subject URL format: %q", apiURL)
	}

	owner = matches[1]
	repo = matches[2]

	parsedNum, err := strconv.ParseInt(matches[4], 10, 32)
	if err != nil {
		return "", "", 0, octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			fmt.Errorf("invalid item number %q in URL %q: %w", matches[4], apiURL, err)
	}
	number = int32(parsedNum)

	switch matches[3] {
	case "pulls":
		itemType = octodeckv1.ItemType_ITEM_TYPE_PR
	case "issues":
		itemType = octodeckv1.ItemType_ITEM_TYPE_ISSUE
	default:
		return "", "", 0, octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			fmt.Errorf("unsupported item type %q in URL %q", matches[3], apiURL)
	}

	return owner, repo, number, itemType, nil
}

// parseNextLink parses the GitHub pagination Link header and returns the URL for rel="next", or empty string if none.
func parseNextLink(linkHeader string) string {
	if linkHeader == "" {
		return ""
	}
	for part := range strings.SplitSeq(linkHeader, ",") {
		sections := strings.Split(strings.TrimSpace(part), ";")
		if len(sections) < minLinkSectionParts {
			continue
		}
		isNext := false
		for _, s := range sections[1:] {
			trimmed := strings.TrimSpace(s)
			if trimmed == `rel="next"` || trimmed == `rel=next` {
				isNext = true
				break
			}
		}
		if isNext {
			urlPart := strings.TrimSpace(sections[0])
			urlPart = strings.TrimPrefix(urlPart, "<")
			urlPart = strings.TrimSuffix(urlPart, ">")
			return urlPart
		}
	}
	return ""
}

// notificationPageResult contains parsed data from a single notifications API page.
type notificationPageResult struct {
	threads      []NotificationThread
	lastModified string
	nextURL      string
	statusCode   int
}

func (c *Client) fetchNotificationPage(
	ctx context.Context,
	pageURL string,
	pageCount int,
	lastModified string,
) (*notificationPageResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create notifications request: %w", err)
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-Github-Api-Version", "2022-11-28")

	// Only send If-Modified-Since on Page 1
	if pageCount == 1 && lastModified != "" {
		req.Header.Set("If-Modified-Since", lastModified)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("notifications request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return &notificationPageResult{
			threads:      []NotificationThread{},
			lastModified: lastModified,
			statusCode:   http.StatusNotModified,
		}, nil
	}

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return &notificationPageResult{
			statusCode: resp.StatusCode,
		}, fmt.Errorf("notifications request returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var pageThreads []NotificationThread
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read notifications response body: %w", err)
	}

	if err := json.Unmarshal(bodyBytes, &pageThreads); err != nil {
		return nil, fmt.Errorf("failed to unmarshal notifications response: %w", err)
	}

	return &notificationPageResult{
		threads:      pageThreads,
		lastModified: resp.Header.Get("Last-Modified"),
		nextURL:      parseNextLink(resp.Header.Get("Link")),
		statusCode:   http.StatusOK,
	}, nil
}

// FetchNotifications queries the GitHub Notifications API (GET /notifications)
// supporting conditional HTTP 304 caching (If-Modified-Since), sliding window (since),
// and Link header pagination up to a safety threshold (max 5 pages / 250 threads).
// The Last-Modified header returned on Page 1 is preserved across pagination runs.
func (c *Client) FetchNotifications(
	ctx context.Context,
	since time.Time,
	lastModified string,
) ([]NotificationThread, string, int, error) {
	if c == nil || c.HTTPClient == nil {
		return nil, "", 0, errors.New("github http client is not initialized")
	}

	reqURL := fmt.Sprintf("%s/notifications?all=true&per_page=%d",
		defaultGitHubAPIBase, notificationsPerPage)
	if !since.IsZero() {
		reqURL += fmt.Sprintf("&since=%s", url.QueryEscape(since.Format(time.RFC3339)))
	}

	var allThreads []NotificationThread
	var page1LastModified string
	currentURL := reqURL
	pageCount := 0

	for currentURL != "" && pageCount < maxNotificationPages && len(allThreads) < maxNotificationThreads {
		pageCount++
		pageRes, err := c.fetchNotificationPage(ctx, currentURL, pageCount, lastModified)
		if err != nil {
			statusCode := 0
			if pageRes != nil {
				statusCode = pageRes.statusCode
			}
			return nil, "", statusCode, err
		}

		if pageRes.statusCode == http.StatusNotModified {
			return []NotificationThread{}, lastModified, http.StatusNotModified, nil
		}

		if pageCount == 1 {
			page1LastModified = pageRes.lastModified
			if page1LastModified == "" {
				page1LastModified = lastModified
			}
		}

		allThreads = append(allThreads, pageRes.threads...)
		currentURL = pageRes.nextURL
	}

	return allThreads, page1LastModified, http.StatusOK, nil
}

// --- GraphQL Structures ---

type gqlUser struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type gqlComment struct {
	DatabaseID int     `json:"databaseId"`
	CreatedAt  string  `json:"createdAt"`
	Body       string  `graphql:"body" json:"body"`
	BodyText   string  `graphql:"bodyText" json:"bodyText"`
	Author     gqlUser `json:"author"`
}

func (c gqlComment) text() string {
	if c.Body != "" {
		return c.Body
	}
	return c.BodyText
}

type gqlCommit struct {
	Commit struct {
		CommittedDate string `json:"committedDate"`
		Author        struct {
			User gqlUser `json:"user"`
		} `json:"author"`
	} `json:"commit"`
}

type gqlMilestone struct {
	Title string `json:"title"`
}

func (m *gqlMilestone) toProto() *octodeckv1.Milestone {
	if m == nil || m.Title == "" {
		return nil
	}
	return octodeckv1.Milestone_builder{
		Title: config.Ptr(m.Title),
	}.Build()
}

type gqlLabel struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (l *gqlLabel) toProto() *octodeckv1.Label {
	if l == nil {
		return nil
	}
	return octodeckv1.Label_builder{
		Name:  config.Ptr(l.Name),
		Color: config.Ptr(l.Color),
	}.Build()
}

func parseSubscriptionState(s string) *octodeckv1.SubscriptionState {
	switch s {
	case subscriptionSubscribed:
		return config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED)
	case subscriptionUnsubscribed:
		return config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED)
	case subscriptionIgnored:
		return config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED)
	default:
		return nil
	}
}

type gqlClosedEvent struct {
	CreatedAt string  `json:"createdAt"`
	URL       string  `json:"url"`
	Actor     gqlUser `json:"actor"`
}

type gqlMergedEvent struct {
	CreatedAt string  `json:"createdAt"`
	URL       string  `json:"url"`
	Actor     gqlUser `json:"actor"`
}

type gqlReopenedEvent struct {
	CreatedAt string  `json:"createdAt"`
	Actor     gqlUser `json:"actor"`
}

type gqlAssignee struct {
	User struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatarUrl"`
	} `graphql:"... on User" json:"user"`
	Bot struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatarUrl"`
	} `graphql:"... on Bot" json:"bot"`
}

func (a gqlAssignee) login() string {
	if a.User.Login != "" {
		return a.User.Login
	}
	if a.Bot.Login != "" {
		return a.Bot.Login
	}
	return ""
}

type gqlAssignedEvent struct {
	CreatedAt string      `json:"createdAt"`
	Actor     gqlUser     `json:"actor"`
	Assignee  gqlAssignee `graphql:"assignee" json:"assignee"`
}

type gqlIssueTimelineItemNode struct {
	Typename      string           `graphql:"__typename" json:"__typename"`
	ClosedEvent   gqlClosedEvent   `graphql:"... on ClosedEvent" json:"closedEvent"`
	ReopenedEvent gqlReopenedEvent `graphql:"... on ReopenedEvent" json:"reopenedEvent"`
	AssignedEvent gqlAssignedEvent `graphql:"... on AssignedEvent" json:"assignedEvent"`
}

func (node gqlIssueTimelineItemNode) toProto(currentUser ...string) *octodeckv1.StateEvent {
	var createdAtStr string
	var actor gqlUser
	var eventURL string
	var changeType octodeckv1.StateChangeType

	switch node.Typename {
	case typeClosedEvent:
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED
		createdAtStr = node.ClosedEvent.CreatedAt
		actor = node.ClosedEvent.Actor
		eventURL = node.ClosedEvent.URL
	case typeReopenedEvent:
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED
		createdAtStr = node.ReopenedEvent.CreatedAt
		actor = node.ReopenedEvent.Actor
	case typeAssignedEvent:
		if len(currentUser) > 0 && currentUser[0] != "" {
			if node.AssignedEvent.Assignee.login() != currentUser[0] {
				return nil
			}
		}
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED
		createdAtStr = node.AssignedEvent.CreatedAt
		actor = node.AssignedEvent.Actor
	default:
		return nil
	}

	var createdAtTime *timestamppb.Timestamp
	if createdAtStr != "" {
		if t, err := time.Parse(time.RFC3339, createdAtStr); err == nil {
			createdAtTime = timestamppb.New(t)
		}
	}

	builder := octodeckv1.StateEvent_builder{
		Type:      config.Ptr(changeType),
		CreatedAt: createdAtTime,
		Actor: octodeckv1.User_builder{
			Login:     config.Ptr(actor.Login),
			AvatarUrl: config.Ptr(actor.AvatarURL),
		}.Build(),
	}
	if eventURL != "" {
		builder.Url = config.Ptr(eventURL)
	}
	return builder.Build()
}

type gqlTimelineItemNode struct {
	Typename      string           `graphql:"__typename" json:"__typename"`
	ClosedEvent   gqlClosedEvent   `graphql:"... on ClosedEvent" json:"closedEvent"`
	MergedEvent   gqlMergedEvent   `graphql:"... on MergedEvent" json:"mergedEvent"`
	ReopenedEvent gqlReopenedEvent `graphql:"... on ReopenedEvent" json:"reopenedEvent"`
	AssignedEvent gqlAssignedEvent `graphql:"... on AssignedEvent" json:"assignedEvent"`
}

func (node gqlTimelineItemNode) toProto(currentUser ...string) *octodeckv1.StateEvent {
	var createdAtStr string
	var actor gqlUser
	var eventURL string
	var changeType octodeckv1.StateChangeType

	switch node.Typename {
	case typeClosedEvent:
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_CLOSED
		createdAtStr = node.ClosedEvent.CreatedAt
		actor = node.ClosedEvent.Actor
		eventURL = node.ClosedEvent.URL
	case typeMergedEvent:
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_MERGED
		createdAtStr = node.MergedEvent.CreatedAt
		actor = node.MergedEvent.Actor
		eventURL = node.MergedEvent.URL
	case typeReopenedEvent:
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_REOPENED
		createdAtStr = node.ReopenedEvent.CreatedAt
		actor = node.ReopenedEvent.Actor
	case typeAssignedEvent:
		if len(currentUser) > 0 && currentUser[0] != "" {
			if node.AssignedEvent.Assignee.login() != currentUser[0] {
				return nil
			}
		}
		changeType = octodeckv1.StateChangeType_STATE_CHANGE_TYPE_ASSIGNED
		createdAtStr = node.AssignedEvent.CreatedAt
		actor = node.AssignedEvent.Actor
	default:
		return nil
	}

	var createdAtTime *timestamppb.Timestamp
	if createdAtStr != "" {
		if t, err := time.Parse(time.RFC3339, createdAtStr); err == nil {
			createdAtTime = timestamppb.New(t)
		}
	}

	builder := octodeckv1.StateEvent_builder{
		Type:      config.Ptr(changeType),
		CreatedAt: createdAtTime,
		Actor: octodeckv1.User_builder{
			Login:     config.Ptr(actor.Login),
			AvatarUrl: config.Ptr(actor.AvatarURL),
		}.Build(),
	}
	if eventURL != "" {
		builder.Url = config.Ptr(eventURL)
	}
	return builder.Build()
}

type gqlIssue struct {
	ID                 string        `json:"id"`
	Number             int32         `json:"number"`
	Title              string        `json:"title"`
	Body               string        `json:"body"`
	CreatedAt          string        `json:"createdAt"`
	UpdatedAt          string        `json:"updatedAt"`
	URL                string        `json:"url"`
	State              string        `json:"state"`
	ViewerSubscription string        `graphql:"viewerSubscription" json:"viewerSubscription"`
	Author             gqlUser       `json:"author"`
	Milestone          *gqlMilestone `graphql:"milestone" json:"milestone"`
	Labels             struct {
		Nodes []gqlLabel `json:"nodes"`
	} `graphql:"labels(first: 50)" json:"labels"`
	Repository struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	Comments struct {
		Nodes []gqlComment `json:"nodes"`
	} `graphql:"comments(last: 20)" json:"comments"`
	Assignees struct {
		Nodes []gqlUser `json:"nodes"`
	} `graphql:"assignees(first: 10)" json:"assignees"`
	TimelineItems struct {
		Nodes []gqlIssueTimelineItemNode `json:"nodes"`
	} `graphql:"timelineItems(last: 10, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT])" json:"timelineItems"` //nolint:lll // GraphQL query struct tag requires long inline argument list
}

func convertComments(nodes []gqlComment) ([]*octodeckv1.Comment, error) {
	var comments []*octodeckv1.Comment
	for _, c := range nodes {
		t, err := time.Parse(time.RFC3339, c.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("failed to parse comment timestamp %q: %w", c.CreatedAt, err)
		}
		comments = append(comments, octodeckv1.Comment_builder{
			CreatedAt: timestamppb.New(t),
			BodyText:  config.Ptr(c.text()),
			CommentId: config.Ptr(int64(c.DatabaseID)),
			Author: octodeckv1.User_builder{
				Login:     config.Ptr(c.Author.Login),
				AvatarUrl: config.Ptr(c.Author.AvatarURL),
			}.Build(),
		}.Build())
	}
	return comments, nil
}

func convertAssignees(nodes []gqlUser) []*octodeckv1.User {
	var assignees []*octodeckv1.User
	for _, u := range nodes {
		assignees = append(assignees, octodeckv1.User_builder{
			Login:     config.Ptr(u.Login),
			AvatarUrl: config.Ptr(u.AvatarURL),
		}.Build())
	}
	return assignees
}

func convertLabels(nodes []gqlLabel) []*octodeckv1.Label {
	var labels []*octodeckv1.Label
	for _, l := range nodes {
		if p := l.toProto(); p != nil {
			labels = append(labels, p)
		}
	}
	return labels
}

func convertCommits(nodes []gqlCommit) ([]*octodeckv1.Commit, error) {
	var commits []*octodeckv1.Commit
	for _, c := range nodes {
		t, err := time.Parse(time.RFC3339, c.Commit.CommittedDate)
		if err != nil {
			return nil, fmt.Errorf("failed to parse commit timestamp %q: %w", c.Commit.CommittedDate, err)
		}
		commits = append(commits, octodeckv1.Commit_builder{
			CommittedDate: timestamppb.New(t),
			AuthorLogin:   config.Ptr(c.Commit.Author.User.Login),
		}.Build())
	}
	return commits, nil
}

func convertReviewComments(nodes []gqlReviewComment, author gqlUser) ([]*octodeckv1.ReviewComment, int32, int32) {
	var reviewComments []*octodeckv1.ReviewComment
	var newThreadsCount int32
	var replyCount int32
	for _, c := range nodes {
		var replyToID string
		if c.ReplyTo != nil && c.ReplyTo.ID != "" {
			replyCount++
			replyToID = c.ReplyTo.ID
		} else {
			newThreadsCount++
		}

		var catTime *timestamppb.Timestamp
		if c.CreatedAt != "" {
			if ct, err := time.Parse(time.RFC3339, c.CreatedAt); err == nil {
				catTime = timestamppb.New(ct)
			}
		}

		reviewComments = append(reviewComments, octodeckv1.ReviewComment_builder{
			Id:        config.Ptr(c.ID),
			Body:      config.Ptr(c.Body),
			Path:      config.Ptr(c.Path),
			Url:       config.Ptr(c.URL),
			CreatedAt: catTime,
			ReplyToId: config.Ptr(replyToID),
			Author: octodeckv1.User_builder{
				Login:     config.Ptr(author.Login),
				AvatarUrl: config.Ptr(author.AvatarURL),
			}.Build(),
		}.Build())
	}
	return reviewComments, newThreadsCount, replyCount
}

func convertReviews(nodes []gqlReview) []*octodeckv1.Review {
	var reviews []*octodeckv1.Review
	for _, r := range nodes {
		if r.SubmittedAt == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, r.SubmittedAt)
		if err != nil {
			slog.Warn("Failed to parse review timestamp", "submittedAt", r.SubmittedAt, "error", err)
			continue
		}

		reviewComments, newThreadsCount, replyCount := convertReviewComments(r.Comments.Nodes, r.Author)
		if len(r.Comments.Nodes) == 0 && r.Comments.TotalCount > 0 {
			newThreadsCount = r.Comments.TotalCount
		}

		reviews = append(reviews, octodeckv1.Review_builder{
			SubmittedAt:     timestamppb.New(t),
			State:           config.Ptr(r.State),
			Body:            config.Ptr(r.Body),
			CommentCount:    config.Ptr(r.Comments.TotalCount),
			Url:             config.Ptr(r.URL),
			NewThreadsCount: config.Ptr(newThreadsCount),
			ReplyCount:      config.Ptr(replyCount),
			Comments:        reviewComments,
			Author: octodeckv1.User_builder{
				Login:     config.Ptr(r.Author.Login),
				AvatarUrl: config.Ptr(r.Author.AvatarURL),
			}.Build(),
		}.Build())
	}
	return reviews
}

func (i gqlIssue) toProto(currentUser ...string) (*octodeckv1.Item, error) {
	updatedAt, err := time.Parse(time.RFC3339, i.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to parse updatedAt %q: %w", i.UpdatedAt, err)
	}

	var createdAtTime *timestamppb.Timestamp
	if i.CreatedAt != "" {
		if t, err := time.Parse(time.RFC3339, i.CreatedAt); err == nil {
			createdAtTime = timestamppb.New(t)
		}
	}

	comments, err := convertComments(i.Comments.Nodes)
	if err != nil {
		return nil, err
	}

	var stateEvents []*octodeckv1.StateEvent
	for _, node := range i.TimelineItems.Nodes {
		if se := node.toProto(currentUser...); se != nil {
			stateEvents = append(stateEvents, se)
		}
	}

	state := octodeckv1.ItemState_ITEM_STATE_OPEN
	if i.State == stateClosed {
		state = octodeckv1.ItemState_ITEM_STATE_CLOSED
	}

	return octodeckv1.Item_builder{
		Id:                 config.Ptr(i.ID),
		Repo:               config.Ptr(i.Repository.NameWithOwner),
		Number:             config.Ptr(i.Number),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_ISSUE),
		Title:              config.Ptr(i.Title),
		Body:               config.Ptr(i.Body),
		State:              config.Ptr(state),
		UpdatedAt:          timestamppb.New(updatedAt),
		CreatedAt:          createdAtTime,
		Url:                config.Ptr(i.URL),
		ViewerSubscription: parseSubscriptionState(i.ViewerSubscription),
		Author: octodeckv1.User_builder{
			Login:     config.Ptr(i.Author.Login),
			AvatarUrl: config.Ptr(i.Author.AvatarURL),
		}.Build(),
		Comments:    comments,
		Assignees:   convertAssignees(i.Assignees.Nodes),
		Milestone:   i.Milestone.toProto(),
		Labels:      convertLabels(i.Labels.Nodes),
		StateEvents: stateEvents,
	}.Build(), nil
}

type gqlReviewComment struct {
	ID        string  `json:"id"`
	Body      string  `json:"body"`
	Path      string  `json:"path"`
	URL       string  `json:"url"`
	CreatedAt string  `json:"createdAt"`
	Author    gqlUser `json:"author"`
	ReplyTo   *struct {
		ID string `json:"id"`
	} `graphql:"replyTo" json:"replyTo"`
}

type gqlReview struct {
	URL         string  `json:"url"`
	Body        string  `json:"body"`
	State       string  `json:"state"`
	SubmittedAt string  `json:"submittedAt"`
	Author      gqlUser `json:"author"`
	Comments    struct {
		TotalCount int32              `json:"totalCount"`
		Nodes      []gqlReviewComment `json:"nodes"`
	} `graphql:"comments(first: 10)" json:"comments"`
}

type gqlPullRequest struct {
	ID                 string        `json:"id"`
	Number             int32         `json:"number"`
	Title              string        `json:"title"`
	Body               string        `json:"body"`
	CreatedAt          string        `json:"createdAt"`
	UpdatedAt          string        `json:"updatedAt"`
	URL                string        `json:"url"`
	State              string        `json:"state"`
	IsDraft            bool          `graphql:"isDraft" json:"isDraft"`
	ViewerSubscription string        `graphql:"viewerSubscription" json:"viewerSubscription"`
	Author             gqlUser       `json:"author"`
	Milestone          *gqlMilestone `graphql:"milestone" json:"milestone"`
	Labels             struct {
		Nodes []gqlLabel `json:"nodes"`
	} `graphql:"labels(first: 50)" json:"labels"`
	Repository struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	Comments struct {
		Nodes []gqlComment `json:"nodes"`
	} `graphql:"comments(last: 20)" json:"comments"`
	Assignees struct {
		Nodes []gqlUser `json:"nodes"`
	} `graphql:"assignees(first: 10)" json:"assignees"`
	Commits struct {
		Nodes []gqlCommit `json:"nodes"`
	} `graphql:"commits(last: 10)" json:"commits"`
	Reviews struct {
		Nodes []gqlReview `json:"nodes"`
	} `graphql:"reviews(last: 10)" json:"reviews"`
	TimelineItems struct {
		Nodes []gqlTimelineItemNode `json:"nodes"`
	} `graphql:"timelineItems(last: 10, itemTypes: [CLOSED_EVENT, MERGED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT])" json:"timelineItems"` //nolint:lll // GraphQL query struct tag requires long inline argument list
}

func (p gqlPullRequest) toProto(currentUser ...string) (*octodeckv1.Item, error) {
	updatedAt, err := time.Parse(time.RFC3339, p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to parse updatedAt %q: %w", p.UpdatedAt, err)
	}

	var createdAtTime *timestamppb.Timestamp
	if p.CreatedAt != "" {
		if t, err := time.Parse(time.RFC3339, p.CreatedAt); err == nil {
			createdAtTime = timestamppb.New(t)
		}
	}

	comments, err := convertComments(p.Comments.Nodes)
	if err != nil {
		return nil, err
	}

	commits, err := convertCommits(p.Commits.Nodes)
	if err != nil {
		return nil, err
	}

	var stateEvents []*octodeckv1.StateEvent
	for _, node := range p.TimelineItems.Nodes {
		if se := node.toProto(currentUser...); se != nil {
			stateEvents = append(stateEvents, se)
		}
	}

	state := octodeckv1.ItemState_ITEM_STATE_OPEN
	switch p.State {
	case stateClosed:
		state = octodeckv1.ItemState_ITEM_STATE_CLOSED
	case stateMerged:
		state = octodeckv1.ItemState_ITEM_STATE_MERGED
	}

	return octodeckv1.Item_builder{
		Id:                 config.Ptr(p.ID),
		Repo:               config.Ptr(p.Repository.NameWithOwner),
		Number:             config.Ptr(p.Number),
		Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
		Title:              config.Ptr(p.Title),
		Body:               config.Ptr(p.Body),
		State:              config.Ptr(state),
		IsDraft:            config.Ptr(p.IsDraft),
		UpdatedAt:          timestamppb.New(updatedAt),
		CreatedAt:          createdAtTime,
		Url:                config.Ptr(p.URL),
		ViewerSubscription: parseSubscriptionState(p.ViewerSubscription),
		Author: octodeckv1.User_builder{
			Login:     config.Ptr(p.Author.Login),
			AvatarUrl: config.Ptr(p.Author.AvatarURL),
		}.Build(),
		Comments:    comments,
		Reviews:     convertReviews(p.Reviews.Nodes),
		Assignees:   convertAssignees(p.Assignees.Nodes),
		Commits:     commits,
		Milestone:   p.Milestone.toProto(),
		Labels:      convertLabels(p.Labels.Nodes),
		StateEvents: stateEvents,
	}.Build(), nil
}

type gqlSearchResultNode struct {
	Typename    string         `graphql:"__typename" json:"__typename"`
	Issue       gqlIssue       `graphql:"... on Issue" json:"issue"`
	PullRequest gqlPullRequest `graphql:"... on PullRequest" json:"pullRequest"`
}

func (n gqlSearchResultNode) toProto(currentUser ...string) (*octodeckv1.Item, error) {
	if n.Typename == typePullRequest {
		return n.PullRequest.toProto(currentUser...)
	}
	if n.Typename == typeIssue {
		return n.Issue.toProto(currentUser...)
	}
	// Skip other types (should not happen if search type is ISSUE)
	return nil, fmt.Errorf("unknown type: %s", n.Typename)
}

type pageInfo struct {
	EndCursor   string `json:"endCursor"`
	HasNextPage bool   `json:"hasNextPage"`
}

// FetchInventory fetches the "Inventory" (Assigned items and Authored items)
// It iterates through all pages of results.
// NOTE: If you change the query used by FetchInventory, you MUST update
// testdata/inventory_query.graphql to match.
func (c *Client) FetchInventory(ctx context.Context) ([]*octodeckv1.Item, error) {
	// Combined query to fetch both assigned and authored items
	// "is:open (assignee:@me OR author:@me) sort:updated-desc"
	return c.fetchAllItems(ctx, "is:open (assignee:@me OR author:@me) sort:updated-desc")
}

func (c *Client) fetchAllItems(ctx context.Context, searchQuery string) ([]*octodeckv1.Item, error) {
	var allItems []*octodeckv1.Item
	var cursor *string // Pointer to string to handle null/nil
	page := 1

	for {
		if page > 1 {
			slog.InfoContext(ctx, "Fetching subsequent page of search items",
				"page", page, "items_so_far", len(allItems))
		}

		var query struct {
			Search struct {
				Nodes    []gqlSearchResultNode `json:"nodes"`
				PageInfo pageInfo              `json:"pageInfo"`
			} `graphql:"search(query: $query, type: ISSUE_ADVANCED, first: $first, after: $cursor)"`
		}

		var gqlCursor *graphql.String
		if cursor != nil {
			c := graphql.String(*cursor)
			gqlCursor = &c
		}

		vars := map[string]any{
			"query":  graphql.String(searchQuery),
			"first":  graphql.Int(searchPageSize),
			"cursor": gqlCursor, //nolint:goconst // GraphQL variable name
		}

		if err := c.GraphQLClient.QueryWithContext(ctx, "InventorySearch", &query, vars); err != nil {
			return nil, err
		}

		for _, node := range query.Search.Nodes {
			item, err := node.toProto(c.CurrentUser)
			if err == nil {
				allItems = append(allItems, item)
			} else {
				slog.WarnContext(ctx, "Failed to parse item", "error", err, "typename", node.Typename)
			}
		}

		if !query.Search.PageInfo.HasNextPage {
			break
		}
		// Update cursor for next iteration
		nextCursor := query.Search.PageInfo.EndCursor
		cursor = &nextCursor
		page++
	}

	return allItems, nil
}

// FetchUserUpdates fetches items updated since a given timestamp where the current user is assigned or author.
// It iterates through all pages of results.
func (c *Client) FetchUserUpdates(ctx context.Context, since time.Time) ([]*octodeckv1.Item, error) {
	ts := since.Format(time.RFC3339)
	searchQuery := fmt.Sprintf("(assignee:@me OR author:@me) updated:>%s sort:updated-desc", ts)
	return c.fetchAllItems(ctx, searchQuery)
}

// FetchItemByRepoAndNumber searches GitHub for an item matching the repository and issue/PR number.
func (c *Client) FetchItemByRepoAndNumber(ctx context.Context, repo string, number int32) (*octodeckv1.Item, error) {
	searchQuery := fmt.Sprintf("repo:%s %d", repo, number)
	items, err := c.fetchAllItems(ctx, searchQuery)
	if err != nil {
		return nil, fmt.Errorf("failed to search for %s#%d: %w", repo, number, err)
	}
	for _, item := range items {
		if item.GetNumber() == number {
			return item, nil
		}
	}
	return nil, fmt.Errorf("item %s#%d not found on GitHub", repo, number)
}

// FetchItemsByIDs fetches details for a specific list of Node IDs.
// It returns the found items and a list of IDs that were not found (deleted/404/error).
func (c *Client) FetchItemsByIDs(ctx context.Context, ids []string) ([]*octodeckv1.Item, []string, error) {
	if len(ids) == 0 {
		return nil, nil, nil
	}

	var foundItems []*octodeckv1.Item
	var missingIDs []string

	// Process in batches of 50 to avoid query complexity limits
	for i := 0; i < len(ids); i += nodeBatchSize {
		end := min(i+nodeBatchSize, len(ids))
		batchIDs := ids[i:end]

		batchFound, batchMissing, err := c.fetchNodesBatch(ctx, batchIDs)
		if err != nil {
			return nil, nil, err
		}
		foundItems = append(foundItems, batchFound...)
		missingIDs = append(missingIDs, batchMissing...)
	}

	return foundItems, missingIDs, nil
}

// FetchItems fetches details for a specific list of items.
// It returns the found (updated) items and a list of IDs that were not found (deleted/404).
// NOTE: If you change the query used by FetchItems, you MUST update
// testdata/items_query.graphql to match.
func (c *Client) FetchItems(ctx context.Context, items []*octodeckv1.Item) ([]*octodeckv1.Item, []string, error) {
	if len(items) == 0 {
		return nil, nil, nil
	}

	ids := make([]string, 0, len(items))
	for _, item := range items {
		if item.GetId() != "" {
			ids = append(ids, item.GetId())
		}
	}

	return c.FetchItemsByIDs(ctx, ids)
}

func (c *Client) fetchNodesBatch(ctx context.Context, ids []string) ([]*octodeckv1.Item, []string, error) {
	var query struct {
		Nodes []*gqlSearchResultNode `graphql:"nodes(ids: $ids)"`
	}

	vars := map[string]any{
		"ids": ids,
	}

	if err := c.GraphQLClient.QueryWithContext(ctx, "ItemsFetch", &query, vars); err != nil {
		return nil, nil, fmt.Errorf("graphql request failed: %w", err)
	}

	var foundItems []*octodeckv1.Item
	var missingIDs []string

	for i, node := range query.Nodes {
		requestedID := ids[i]
		if node == nil {
			missingIDs = append(missingIDs, requestedID)
			continue
		}

		item, err := node.toProto(c.CurrentUser)
		if err != nil {
			slog.WarnContext(ctx, "Failed to parse item during GC", "id", requestedID, "error", err)
			missingIDs = append(missingIDs, requestedID)
			continue
		}
		foundItems = append(foundItems, item)
	}

	return foundItems, missingIDs, nil
}

// FetchItemComments fetches comments for a specific item (Issue or PR)
// by paginating backwards from the newest comments until it reaches comments
// older than the 'minID' threshold.
func (c *Client) fetchCommentNodesBatch(
	ctx context.Context,
	id string,
	cursor *string,
) ([]gqlComment, string, bool, error) {
	var query struct {
		Node struct {
			Typename string `graphql:"__typename" json:"__typename"`
			Issue    struct {
				URL      string `json:"url"`
				Comments struct {
					Nodes    []gqlComment `json:"nodes"`
					PageInfo struct {
						StartCursor     string `json:"startCursor"`
						HasPreviousPage bool   `json:"hasPreviousPage"`
					} `json:"pageInfo"`
				} `graphql:"comments(last: 100, before: $cursor)" json:"comments"`
			} `graphql:"... on Issue" json:"issue"`
			PullRequest struct {
				URL      string `json:"url"`
				Comments struct {
					Nodes    []gqlComment `json:"nodes"`
					PageInfo struct {
						StartCursor     string `json:"startCursor"`
						HasPreviousPage bool   `json:"hasPreviousPage"`
					} `json:"pageInfo"`
				} `graphql:"comments(last: 100, before: $cursor)" json:"comments"`
			} `graphql:"... on PullRequest" json:"pullRequest"`
		} `graphql:"node(id: $id)" json:"node"`
	}

	var gqlCursor *graphql.String
	if cursor != nil {
		cu := graphql.String(*cursor)
		gqlCursor = &cu
	}

	vars := map[string]any{
		"id":     graphql.ID(id),
		"cursor": gqlCursor,
	}

	if err := c.GraphQLClient.QueryWithContext(ctx, "FetchItemComments", &query, vars); err != nil {
		return nil, "", false, fmt.Errorf("failed to fetch item comments: %w", err)
	}

	switch query.Node.Typename {
	case typeIssue:
		return query.Node.Issue.Comments.Nodes,
			query.Node.Issue.Comments.PageInfo.StartCursor,
			query.Node.Issue.Comments.PageInfo.HasPreviousPage,
			nil
	case typePullRequest:
		return query.Node.PullRequest.Comments.Nodes,
			query.Node.PullRequest.Comments.PageInfo.StartCursor,
			query.Node.PullRequest.Comments.PageInfo.HasPreviousPage,
			nil
	default:
		return nil, "", false, fmt.Errorf("unexpected type for comment fetch: %s", query.Node.Typename)
	}
}

func parseCommentNode(ctx context.Context, itemID string, n gqlComment) (*octodeckv1.Comment, bool) {
	t, err := time.Parse(time.RFC3339, n.CreatedAt)
	if err != nil {
		slog.WarnContext(ctx, "failed to parse comment timestamp",
			"id", itemID,
			"comment_id", n.DatabaseID,
			"timestamp", n.CreatedAt,
			"error", err,
		)
		return nil, false
	}

	return octodeckv1.Comment_builder{
		CreatedAt: timestamppb.New(t),
		BodyText:  config.Ptr(n.text()),
		CommentId: config.Ptr(int64(n.DatabaseID)),
		Author: octodeckv1.User_builder{
			Login:     config.Ptr(n.Author.Login),
			AvatarUrl: config.Ptr(n.Author.AvatarURL),
		}.Build(),
	}.Build(), true
}

// FetchItemComments fetches comments for a specific item (Issue or PR)
// by paginating backwards from the newest comments until it reaches comments
// older than the 'minID' threshold.
func (c *Client) FetchItemComments(ctx context.Context, id string, minID int64) ([]*octodeckv1.Comment, error) {
	var allComments []*octodeckv1.Comment
	var cursor *string

	for {
		nodes, startCursor, hasPrevious, err := c.fetchCommentNodesBatch(ctx, id, cursor)
		if err != nil {
			return nil, err
		}
		if len(nodes) == 0 {
			break
		}

		reachedLimit := false
		for _, n := range slices.Backward(nodes) {
			if minID > 0 && int64(n.DatabaseID) <= minID {
				reachedLimit = true
				break
			}
			if cProto, ok := parseCommentNode(ctx, id, n); ok {
				allComments = append(allComments, cProto)
			}
		}

		if reachedLimit || !hasPrevious {
			break
		}
		cursor = &startCursor
	}

	slices.Reverse(allComments)
	return allComments, nil
}
