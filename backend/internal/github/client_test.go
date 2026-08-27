package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

func TestNewClient(t *testing.T) {
	client, err := NewClient()
	require.NoError(t, err, "Failed to create client")
	require.NotNil(t, client.RestClient, "Client.RestClient is nil")
	require.NotNil(t, client.HTTPClient, "Client.HTTPClient is nil")
}

type mockRESTClient struct {
	doFunc func(ctx context.Context, method string, path string, body io.Reader, response any) error
}

func (m *mockRESTClient) DoWithContext(ctx context.Context, method string, path string, body io.Reader,
	response any) error {
	return m.doFunc(ctx, method, path, body, response)
}

type mockHTTPClient struct {
	doFunc func(req *http.Request) (*http.Response, error)
}

func (m *mockHTTPClient) Do(req *http.Request) (*http.Response, error) {
	return m.doFunc(req)
}

func TestCheckAuth_Unit(t *testing.T) {
	tests := []struct {
		name     string
		doFunc   func(ctx context.Context, method string, path string, body io.Reader, response any) error
		wantAuth bool
		wantErr  bool
	}{
		{
			name: "Authenticated",
			doFunc: func(_ context.Context, _ string, path string, _ io.Reader, _ any) error {
				if path != "user" {
					return fmt.Errorf("unexpected path: %s", path)
				}
				return nil
			},
			wantAuth: true,
			wantErr:  false,
		},
		{
			name: "Not Authenticated",
			doFunc: func(_ context.Context, _ string, _ string, _ io.Reader, _ any) error {
				return errors.New("auth failed")
			},
			wantAuth: false,
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockRESTClient{doFunc: tt.doFunc}
			client := &Client{RestClient: mock}
			_, gotAuth, err := client.CheckAuth(t.Context())
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tt.wantAuth, gotAuth)
		})
	}
}

func TestParseSubjectURL(t *testing.T) {
	tests := []struct {
		name         string
		url          string
		wantOwner    string
		wantRepo     string
		wantNumber   int32
		wantItemType octodeckv1.ItemType
		wantErr      bool
	}{
		{
			name:         "Valid Pull Request URL",
			url:          "https://api.github.com/repos/kubernetes-sigs/node-readiness-controller/pulls/402",
			wantOwner:    "kubernetes-sigs",
			wantRepo:     "node-readiness-controller",
			wantNumber:   402,
			wantItemType: octodeckv1.ItemType_ITEM_TYPE_PR,
			wantErr:      false,
		},
		{
			name:         "Valid Issue URL",
			url:          "https://api.github.com/repos/kubernetes/kubernetes/issues/12345",
			wantOwner:    "kubernetes",
			wantRepo:     "kubernetes",
			wantNumber:   12345,
			wantItemType: octodeckv1.ItemType_ITEM_TYPE_ISSUE,
			wantErr:      false,
		},
		{
			name:         "Valid Repo with dots and dashes",
			url:          "https://api.github.com/repos/k8s.io/test-infra/pulls/99",
			wantOwner:    "k8s.io",
			wantRepo:     "test-infra",
			wantNumber:   99,
			wantItemType: octodeckv1.ItemType_ITEM_TYPE_PR,
			wantErr:      false,
		},
		{
			name:         "Valid Repo with underscores",
			url:          "https://api.github.com/repos/my_org/my_repo/issues/1",
			wantOwner:    "my_org",
			wantRepo:     "my_repo",
			wantNumber:   1,
			wantItemType: octodeckv1.ItemType_ITEM_TYPE_ISSUE,
			wantErr:      false,
		},
		{
			name:    "Empty URL",
			url:     "",
			wantErr: true,
		},
		{
			name:    "Unsupported Type - Release",
			url:     "https://api.github.com/repos/kubernetes/kubernetes/releases/199999",
			wantErr: true,
		},
		{
			name:    "Unsupported Type - Discussion",
			url:     "https://api.github.com/repos/kubernetes/kubernetes/discussions/42",
			wantErr: true,
		},
		{
			name:    "HTML URL (Not API URL)",
			url:     "https://github.com/kubernetes/kubernetes/pull/123",
			wantErr: true,
		},
		{
			name:    "Malformed URL Path",
			url:     "https://api.github.com/not-repos/owner/repo/pulls/1",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			owner, repo, number, itemType, err := ParseSubjectURL(tt.url)
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantOwner, owner)
				assert.Equal(t, tt.wantRepo, repo)
				assert.Equal(t, tt.wantNumber, number)
				assert.Equal(t, tt.wantItemType, itemType)
			}
		})
	}
}

func TestFetchNotifications_RealFixture(t *testing.T) {
	fixtureData, err := os.ReadFile("testdata/notifications_response.json")
	require.NoError(t, err, "Failed to read notifications fixture")

	mock := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			assert.Equal(t, "application/vnd.github+json", req.Header.Get("Accept"))
			assert.Equal(t, "2022-11-28", req.Header.Get("X-Github-Api-Version"))
			assert.Contains(t, req.URL.String(), "/notifications?all=true&per_page=50")

			resp := &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewReader(fixtureData)),
			}
			resp.Header.Set("Last-Modified", "Thu, 14 Aug 2026 01:54:16 GMT")
			return resp, nil
		},
	}

	client := &Client{HTTPClient: mock}
	threads, lastModified, status, err := client.FetchNotifications(t.Context(), time.Time{}, "")

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, "Thu, 14 Aug 2026 01:54:16 GMT", lastModified)
	require.Len(t, threads, 6)

	// Thread 0: PR
	assert.Equal(t, "25068083761", threads[0].ID)
	assert.True(t, threads[0].Unread)
	assert.Equal(t, "subscribed", threads[0].Reason)
	assert.Equal(t, "kubernetes-sigs/node-readiness-controller", threads[0].Repository.FullName)
	assert.Equal(t, "PullRequest", threads[0].Subject.Type)
	owner, repo, num, itemType, err := ParseSubjectURL(threads[0].Subject.URL)
	require.NoError(t, err)
	assert.Equal(t, "kubernetes-sigs", owner)
	assert.Equal(t, "node-readiness-controller", repo)
	assert.Equal(t, int32(402), num)
	assert.Equal(t, octodeckv1.ItemType_ITEM_TYPE_PR, itemType)

	// Thread 2: Issue
	assert.Equal(t, "24987654321", threads[2].ID)
	assert.False(t, threads[2].Unread)
	assert.Equal(t, "assign", threads[2].Reason)
	assert.Equal(t, "Issue", threads[2].Subject.Type)
	owner, repo, num, itemType, err = ParseSubjectURL(threads[2].Subject.URL)
	require.NoError(t, err)
	assert.Equal(t, "kubernetes", owner)
	assert.Equal(t, "kubernetes", repo)
	assert.Equal(t, int32(12345), num)
	assert.Equal(t, octodeckv1.ItemType_ITEM_TYPE_ISSUE, itemType)

	// Thread 4: Release (non-issue/PR)
	assert.Equal(t, "Release", threads[4].Subject.Type)
	_, _, _, _, err = ParseSubjectURL(threads[4].Subject.URL)
	require.Error(t, err)

	// Thread 5: CheckSuite (empty subject URL)
	assert.Equal(t, "CheckSuite", threads[5].Subject.Type)
	_, _, _, _, err = ParseSubjectURL(threads[5].Subject.URL)
	require.Error(t, err)
}

func TestFetchNotifications_304NotModified(t *testing.T) {
	var sentIfModifiedSince string
	mock := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			sentIfModifiedSince = req.Header.Get("If-Modified-Since")
			resp := &http.Response{
				StatusCode: http.StatusNotModified,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewReader(nil)),
			}
			return resp, nil
		},
	}

	client := &Client{HTTPClient: mock}
	initialLastModified := "Thu, 14 Aug 2026 01:00:00 GMT"
	threads, lastModified, status, err := client.FetchNotifications(t.Context(), time.Time{}, initialLastModified)

	require.NoError(t, err)
	assert.Equal(t, http.StatusNotModified, status)
	assert.Equal(t, initialLastModified, lastModified)
	assert.Empty(t, threads)
	assert.Equal(t, initialLastModified, sentIfModifiedSince)
}

func TestFetchNotifications_PaginationAndPreservePage1LastModified(t *testing.T) {
	page1Body := `[
		{"id": "t1", "unread": true, "reason": "mention",
		 "subject": {"title": "T1", "type": "Issue", "url": "https://api.github.com/repos/o/r/issues/1"},
		 "repository": {"full_name": "o/r"}},
		{"id": "t2", "unread": false, "reason": "author",
		 "subject": {"title": "T2", "type": "PullRequest", "url": "https://api.github.com/repos/o/r/pulls/2"},
		 "repository": {"full_name": "o/r"}}
	]`
	page2Body := `[
		{"id": "t3", "unread": true, "reason": "assign",
		 "subject": {"title": "T3", "type": "Issue", "url": "https://api.github.com/repos/o/r/issues/3"},
		 "repository": {"full_name": "o/r"}},
		{"id": "t4", "unread": true, "reason": "review_requested",
		 "subject": {"title": "T4", "type": "PullRequest", "url": "https://api.github.com/repos/o/r/pulls/4"},
		 "repository": {"full_name": "o/r"}}
	]`
	page3Body := `[
		{"id": "t5", "unread": false, "reason": "subscribed",
		 "subject": {"title": "T5", "type": "Issue", "url": "https://api.github.com/repos/o/r/issues/5"},
		 "repository": {"full_name": "o/r"}}
	]`

	requestCount := 0
	mock := &mockHTTPClient{
		doFunc: func(_ *http.Request) (*http.Response, error) {
			requestCount++
			resp := &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
			}

			switch requestCount {
			case 1:
				resp.Header.Set("Last-Modified", "Page1-Header-Timestamp")
				resp.Header.Set("Link", `<https://api.github.com/notifications?all=true&page=2>; rel="next"`)
				resp.Body = io.NopCloser(bytes.NewBufferString(page1Body))
			case 2:
				// Page 2 header might differ or be absent
				resp.Header.Set("Last-Modified", "Page2-Header-Timestamp")
				resp.Header.Set("Link", `<https://api.github.com/notifications?all=true&page=3>; rel="next"`)
				resp.Body = io.NopCloser(bytes.NewBufferString(page2Body))
			case 3:
				resp.Body = io.NopCloser(bytes.NewBufferString(page3Body))
			default:
				return nil, fmt.Errorf("unexpected request count: %d", requestCount)
			}
			return resp, nil
		},
	}

	client := &Client{HTTPClient: mock}
	threads, lastModified, status, err := client.FetchNotifications(t.Context(), time.Time{}, "")

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, "Page1-Header-Timestamp", lastModified, "Last-Modified header must be preserved from Page 1")
	assert.Equal(t, 3, requestCount)
	require.Len(t, threads, 5)
	assert.Equal(t, "t1", threads[0].ID)
	assert.Equal(t, "t5", threads[4].ID)
}

func TestFetchNotifications_PaginationSafetyCap(t *testing.T) {
	pageBody := `[{"id": "t", "unread": true, "reason": "mention", ` +
		`"subject": {"title": "T", "type": "Issue", "url": "https://api.github.com/repos/o/r/issues/1"}, ` +
		`"repository": {"full_name": "o/r"}}]`
	requestCount := 0

	mock := &mockHTTPClient{
		doFunc: func(_ *http.Request) (*http.Response, error) {
			requestCount++
			resp := &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewBufferString(pageBody)),
			}
			// Always return next link to simulate infinite pages
			resp.Header.Set("Link", `<https://api.github.com/notifications?page=next>; rel="next"`)
			resp.Header.Set("Last-Modified", "Page1-Header")
			return resp, nil
		},
	}

	client := &Client{HTTPClient: mock}
	threads, lastModified, status, err := client.FetchNotifications(t.Context(), time.Time{}, "")

	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, "Page1-Header", lastModified)
	assert.Equal(t, maxNotificationPages, requestCount, "Pagination should halt at safety cap")
	assert.Len(t, threads, maxNotificationPages)
}

func TestFetchNotifications_HTTPError(t *testing.T) {
	mock := &mockHTTPClient{
		doFunc: func(_ *http.Request) (*http.Response, error) {
			resp := &http.Response{
				StatusCode: http.StatusUnauthorized,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewBufferString(`{"message": "Bad credentials"}`)),
			}
			return resp, nil
		},
	}

	client := &Client{HTTPClient: mock}
	_, _, status, err := client.FetchNotifications(t.Context(), time.Time{}, "")

	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Contains(t, err.Error(), "401")
	assert.Contains(t, err.Error(), "Bad credentials")
}

func TestFetchNotifications_UninitializedClient(t *testing.T) {
	var client *Client
	_, _, _, err := client.FetchNotifications(t.Context(), time.Time{}, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not initialized")
}
