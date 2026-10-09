package query

import (
	"slices"
	"strconv"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/logic"
)

// Shared fixtures and evaluation vectors. The same vectors drive the in-memory evaluation tests
// and the SQL prefilter conformance tests, so they double as the engine's conformance suite.

const testUser = "me"

var testBots = []string{"k8s-ci-robot"} //nolint:gochecknoglobals // test fixture

var (
	tBase   = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) //nolint:gochecknoglobals // test fixture
	tViewed = tBase.Add(10 * time.Hour)                   //nolint:gochecknoglobals // test fixture
	tNew    = tBase.Add(20 * time.Hour)                   //nolint:gochecknoglobals // test fixture
)

// fixture describes one test item. Zero values mean "absent".
type fixture struct {
	id        string
	repo      string
	number    int32
	typ       octodeckv1.ItemType
	urlKind   string // "pull" or "issues"; defaults from typ
	state     octodeckv1.ItemState
	author    string
	assignees []string
	labels    []string
	milestone *string
	draft     bool
	sub       octodeckv1.SubscriptionState
	starred   bool
	title     string
	body      string

	created  time.Time // defaults to tBase
	updated  time.Time
	viewed   time.Time
	ackedAt  time.Time
	ackedAct time.Time
	comments []fixtureComment
	commits  []fixtureCommit
}

type fixtureComment struct {
	author string
	body   string
	at     time.Time
}

type fixtureCommit struct {
	author string
	at     time.Time
}

func (f fixture) build() *octodeckv1.Item {
	urlKind := f.urlKind
	if urlKind == "" {
		urlKind = "issues"
		if f.typ == octodeckv1.ItemType_ITEM_TYPE_PR {
			urlKind = "pull"
		}
	}
	created := f.created
	if created.IsZero() {
		created = tBase
	}
	b := octodeckv1.Item_builder{
		Id:                 config.Ptr(f.id),
		Repo:               config.Ptr(f.repo),
		Number:             config.Ptr(f.number),
		Type:               f.typ.Enum(),
		Url:                config.Ptr("https://github.com/" + f.repo + "/" + urlKind + "/" + f.id),
		State:              f.state.Enum(),
		IsDraft:            config.Ptr(f.draft),
		ViewerSubscription: f.sub.Enum(),
		Title:              config.Ptr(f.title),
		Body:               config.Ptr(f.body),
		CreatedAt:          timestamppb.New(created),
		UpdatedAt:          timestamppb.New(f.updated),
	}
	if f.author != "" {
		b.Author = octodeckv1.User_builder{Login: config.Ptr(f.author)}.Build()
	}
	for _, a := range f.assignees {
		b.Assignees = append(b.Assignees, octodeckv1.User_builder{Login: config.Ptr(a)}.Build())
	}
	for i, l := range f.labels {
		color := []string{"d73a4a", "0075ca", "a2eeef"}[i%3]
		b.Labels = append(b.Labels, octodeckv1.Label_builder{Name: config.Ptr(l), Color: config.Ptr(color)}.Build())
	}
	if f.milestone != nil {
		b.Milestone = octodeckv1.Milestone_builder{Title: f.milestone}.Build()
	}
	for _, c := range f.comments {
		b.Comments = append(b.Comments, octodeckv1.Comment_builder{
			CreatedAt: timestamppb.New(c.at),
			BodyText:  config.Ptr(c.body),
			Author:    octodeckv1.User_builder{Login: config.Ptr(c.author)}.Build(),
		}.Build())
	}
	for _, c := range f.commits {
		b.Commits = append(b.Commits, octodeckv1.Commit_builder{
			CommittedDate: timestamppb.New(c.at),
			AuthorLogin:   config.Ptr(c.author),
		}.Build())
	}
	local := octodeckv1.ItemLocalState_builder{Starred: config.Ptr(f.starred)}
	if !f.viewed.IsZero() {
		local.LastViewedAt = timestamppb.New(f.viewed)
	}
	if !f.ackedAt.IsZero() {
		local.AckedAt = timestamppb.New(f.ackedAt)
	}
	if !f.ackedAct.IsZero() {
		local.AckedActivityAt = timestamppb.New(f.ackedAct)
	}
	b.Local = local.Build()
	return b.Build()
}

const (
	pr     = octodeckv1.ItemType_ITEM_TYPE_PR
	issue  = octodeckv1.ItemType_ITEM_TYPE_ISSUE
	open   = octodeckv1.ItemState_ITEM_STATE_OPEN
	closed = octodeckv1.ItemState_ITEM_STATE_CLOSED
	merged = octodeckv1.ItemState_ITEM_STATE_MERGED
	subbed = octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED
)

// coreFixtures is the main evaluation universe (design §8 vectors). Expected activity:
//
//	F01 mention+comment+code, F02 idle, F03 acked, F04 noise, F05 item+code+comment, F06 idle,
//	F07 idle, F08 comment+noise (ack superseded), F09 acked (noise doesn't un-ack), F10 idle,
//	F11 idle.
func coreFixtures() []fixture {
	return []fixture{
		{
			id: "F01", repo: "kubernetes/kubernetes", number: 101, typ: pr, state: open, author: "alice",
			assignees: []string{"me"}, labels: []string{"bug", "good first issue"}, milestone: config.Ptr("v1.32"),
			sub: subbed, starred: true, title: "Fix flaky scheduler test", body: "The scheduler is flaky on arm64",
			viewed: tViewed, updated: tNew,
			comments: []fixtureComment{{author: "bob", body: "ping @me please", at: tNew}},
			commits:  []fixtureCommit{{author: "carol", at: tNew}},
		},
		{
			id: "F02", repo: "kubernetes/minikube", number: 202, typ: issue, state: closed, author: "Bob",
			assignees: []string{"alice"}, labels: []string{"kind/feature"},
			sub:   octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
			title: "Minikube startup issue", body: "Fails to start driver on linux",
			viewed: tViewed, updated: tViewed.Add(-time.Hour),
		},
		{
			id: "F03", repo: "golang/go", number: 303, typ: pr, state: merged, author: "carol",
			milestone: config.Ptr("Go1.24"), sub: subbed,
			title: "Compiler optimization", body: "Escape analysis improvement",
			updated: tNew, ackedAt: tNew.Add(time.Hour), ackedAct: tNew,
		},
		{
			id: "F04", repo: "golang/go", number: 404, typ: pr, state: open, author: "dave", draft: true,
			sub:   octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_IGNORED,
			title: "Noise PR", body: "Only bot comments",
			viewed: tViewed, updated: tNew,
			comments: []fixtureComment{{author: "k8s-ci-robot", body: "CI passed", at: tNew}},
		},
		{
			id: "F05", repo: "golang/tools", number: 505, typ: pr, state: open, author: "eve",
			assignees: []string{"bob", "Me"}, labels: []string{"enhancement"}, sub: subbed,
			title: "Add gopls feature", body: "Implements the feature",
			updated:  tBase.Add(2 * time.Hour),
			commits:  []fixtureCommit{{author: "eve", at: tBase.Add(time.Hour)}},
			comments: []fixtureComment{{author: "frank", body: "nice work", at: tBase.Add(2 * time.Hour)}},
		},
		{
			id: "F06", repo: "owner/repo", number: 606, typ: octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			urlKind: "pull", state: octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED, author: "frank",
			sub:   octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSPECIFIED,
			title: "Legacy row", viewed: tViewed, updated: tViewed,
		},
		{
			id: "F07", repo: "owner/repo", number: 607, typ: octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			urlKind: "issues", state: open, author: "Frank", labels: []string{"Bug"}, milestone: config.Ptr(""),
			sub: subbed, title: "Tidy imports", body: "nothing to see", viewed: tViewed, updated: tViewed,
		},
		{
			id: "F08", repo: "org2/app", number: 808, typ: issue, state: open, author: "gina", sub: subbed,
			title: "Crash on start", body: "test is flaky sometimes",
			updated: tNew, ackedAt: tViewed, ackedAct: tViewed,
			comments: []fixtureComment{
				{author: "bob", body: "I can reproduce this", at: tNew},
				{author: "k8s-ci-robot", body: "CI passed", at: tNew},
			},
		},
		{
			id: "F09", repo: "org2/app", number: 809, typ: issue, state: open, author: "gina", sub: subbed,
			title: "Old ack", updated: tNew, ackedAt: tViewed, ackedAct: tViewed,
			comments: []fixtureComment{{author: "k8s-ci-robot", body: "CI passed", at: tNew}},
		},
		{
			id: "F10", repo: "Kubernetes/Enhancements", number: 123, typ: issue, state: open,
			author: "kubernetes-fan", labels: []string{"kubernetes"}, milestone: config.Ptr("kubernetes-1.0"),
			sub: subbed, title: "Docs typo", body: "typo fix", viewed: tViewed, updated: tViewed,
		},
		{
			id: "F11", repo: "org2/app", number: 77, typ: issue, state: open, author: "me", sub: subbed,
			title: "Follow-up to PR 4567", body: "flaky test seen in CI", viewed: tViewed, updated: tViewed,
		},
	}
}

// edgeFixtures exercise the SQL prefilter's exactness rules: unknown and unspecified enum values
// with the URL fallback, mixed-case and non-ASCII identifiers, LIKE metacharacters in owners, and a
// missing author. All are idle (seen, no new activity); E6 is acked.
func edgeFixtures() []fixture {
	idle := func(f fixture) fixture {
		f.sub = subbed
		f.viewed = tViewed
		f.updated = tViewed
		return f
	}
	e6 := idle(fixture{id: "E6", repo: "Owner/Repo", number: 6, typ: issue, state: open, author: "bob",
		title: "Acked edge"})
	e6.viewed = time.Time{}
	e6.ackedAt = tViewed
	e6.ackedAct = tViewed
	return []fixture{
		idle(fixture{id: "E1", repo: "my_org/r", number: 1, typ: octodeckv1.ItemType(7), urlKind: "pull",
			state: open, author: "Alice", title: "Unknown type number"}),
		idle(fixture{id: "E2", repo: "myXorg/r", number: 2, typ: issue, state: open, author: "ZOË",
			title: "Non-ASCII author"}),
		idle(fixture{id: "E3", repo: "a%b/x", number: 3, typ: pr, state: octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED,
			title: "No author"}),
		idle(fixture{id: "E4", repo: "aZZb/x", number: 4, typ: pr, state: merged, author: "\u212Aate",
			title: "Kelvin sign author"}),
		idle(fixture{id: "E5", repo: "Owner/Repo", number: 5, typ: octodeckv1.ItemType_ITEM_TYPE_UNSPECIFIED,
			urlKind: "issues", state: closed, author: "alice", labels: []string{"bug"}, title: "Legacy issue"}),
		e6,
	}
}

func buildItems(fs []fixture) []*octodeckv1.Item {
	items := make([]*octodeckv1.Item, len(fs))
	for i, f := range fs {
		items[i] = f.build()
	}
	return items
}

func cloneItems(items []*octodeckv1.Item) []*octodeckv1.Item {
	out := make([]*octodeckv1.Item, len(items))
	for i, it := range items {
		out[i] = proto.CloneOf(it)
	}
	return out
}

func ids(views []*View) []string {
	out := make([]string, len(views))
	for i, v := range views {
		out[i] = v.Item.GetId()
	}
	return out
}

// Expression builders.

func p(field octodeckv1.Field, values ...string) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Predicate: octodeckv1.Predicate_builder{
		Field: field.Enum(), Values: values,
	}.Build()}.Build()
}

func np(field octodeckv1.Field, values ...string) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Predicate: octodeckv1.Predicate_builder{
		Field: field.Enum(), Values: values, Negated: config.Ptr(true),
	}.Build()}.Build()
}

func andE(exprs ...*octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{And: octodeckv1.ExprList_builder{Exprs: exprs}.Build()}.Build()
}

func orE(exprs ...*octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Or: octodeckv1.ExprList_builder{Exprs: exprs}.Build()}.Build()
}

func notE(e *octodeckv1.Expr) *octodeckv1.Expr {
	return octodeckv1.Expr_builder{Not: e}.Build()
}

// ta scopes exprs to triage:all.
func ta(exprs ...*octodeckv1.Expr) *octodeckv1.Expr {
	return andE(append([]*octodeckv1.Expr{p(fTriage, "all")}, exprs...)...)
}

const (
	fTriage    = octodeckv1.Field_FIELD_TRIAGE
	fState     = octodeckv1.Field_FIELD_STATE
	fType      = octodeckv1.Field_FIELD_TYPE
	fDraft     = octodeckv1.Field_FIELD_DRAFT
	fTracking  = octodeckv1.Field_FIELD_TRACKING
	fStarred   = octodeckv1.Field_FIELD_STARRED
	fNew       = octodeckv1.Field_FIELD_NEW
	fRepo      = octodeckv1.Field_FIELD_REPO
	fOrg       = octodeckv1.Field_FIELD_ORG
	fAuthor    = octodeckv1.Field_FIELD_AUTHOR
	fAssignee  = octodeckv1.Field_FIELD_ASSIGNEE
	fMilestone = octodeckv1.Field_FIELD_MILESTONE
	fLabel     = octodeckv1.Field_FIELD_LABEL
	fNo        = octodeckv1.Field_FIELD_NO
	fIn        = octodeckv1.Field_FIELD_IN
	fText      = octodeckv1.Field_FIELD_TEXT
)

// evalCase is one evaluation vector: expression -> expected item IDs (as a set).
type evalCase struct {
	name   string
	expr   *octodeckv1.Expr
	noUser bool // evaluate with an unknown current user
	want   []string
}

func (c evalCase) user() string {
	if c.noUser {
		return ""
	}
	return testUser
}

// set helpers for expected IDs.
func idsOf(fs []fixture) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.id
	}
	return out
}

func except(all []string, drop ...string) []string {
	var out []string
	for _, id := range all {
		if !slices.Contains(drop, id) {
			out = append(out, id)
		}
	}
	return out
}

func union(sets ...[]string) []string {
	var out []string
	for _, s := range sets {
		for _, id := range s {
			if !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
	}
	return out
}

func list(ids ...string) []string { return ids }

// coreCases are the evaluation vectors over coreFixtures. They cover every vocabulary field,
// negation, OR values, repeated AND, nesting, @me, triage:all and the implicit triage:inbox.
func coreCases() []evalCase {
	all := idsOf(coreFixtures())
	acked := list("F03", "F09")
	inbox := except(all, acked...)
	var cases []evalCase
	cases = append(cases, triageCases(all, acked, inbox)...)
	cases = append(cases, flagFieldCases(all)...)
	cases = append(cases, newCases(all)...)
	cases = append(cases, identityCases(all)...)
	cases = append(cases, nameCases(all)...)
	cases = append(cases, textCases()...)
	cases = append(cases, nestingCases()...)
	return cases
}

func triageCases(all, acked, inbox []string) []evalCase {
	return []evalCase{
		{name: "nil query is inbox", expr: nil, want: inbox},
		{name: "unset root is inbox", expr: &octodeckv1.Expr{}, want: inbox},
		{name: "empty and is inbox", expr: andE(), want: inbox},
		{name: "triage:inbox", expr: p(fTriage, "inbox"), want: inbox},
		{name: "triage:acked", expr: p(fTriage, "acked"), want: acked},
		{name: "triage:all", expr: p(fTriage, "all"), want: all},
		{name: "triage:inbox,acked", expr: p(fTriage, "inbox", "acked"), want: all},
		{name: "-triage:acked", expr: np(fTriage, "acked"), want: inbox},
		{name: "-triage:all", expr: np(fTriage, "all"), want: nil},
		{name: "triage values are case-insensitive", expr: p(fTriage, "ACKED"), want: acked},
		{name: "no triage predicate gets implicit inbox", expr: p(fRepo, "golang/go"), want: list("F04")},
		{
			name: "triage inside or disables implicit inbox",
			expr: orE(p(fTriage, "acked"), p(fRepo, "golang/go")), want: list("F03", "F04", "F09"),
		},
		{name: "triage under not disables implicit inbox", expr: notE(p(fTriage, "inbox")), want: acked},
		{
			name: "deeply nested triage disables implicit inbox",
			expr: andE(p(fRepo, "org2/app"), notE(notE(p(fTriage, "all")))), want: list("F08", "F09", "F11"),
		},
	}
}

func flagFieldCases(all []string) []evalCase {
	open := list("F01", "F04", "F05", "F06", "F07", "F08", "F09", "F10", "F11")
	issues := list("F02", "F07", "F08", "F09", "F10", "F11")
	return []evalCase{
		{name: "state:open includes unspecified", expr: ta(p(fState, "open")), want: open},
		{name: "state:closed includes merged", expr: ta(p(fState, "closed")), want: list("F02", "F03")},
		{name: "state:merged", expr: ta(p(fState, "merged")), want: list("F03")},
		{name: "state:open,merged", expr: ta(p(fState, "open", "merged")), want: union(open, list("F03"))},
		{name: "-state:open", expr: ta(np(fState, "open")), want: list("F02", "F03")},
		{name: "state:open AND state:closed", expr: ta(p(fState, "open"), p(fState, "closed")), want: nil},
		{name: "state values are case-insensitive", expr: ta(p(fState, "Closed")), want: list("F02", "F03")},
		{name: "type:pr with URL fallback", expr: ta(p(fType, "pr")), want: list("F01", "F03", "F04", "F05", "F06")},
		{name: "type:issue with URL fallback", expr: ta(p(fType, "issue")), want: issues},
		{name: "-type:pr", expr: ta(np(fType, "pr")), want: issues},
		{name: "type:pr,issue", expr: ta(p(fType, "pr", "issue")), want: all},
		{name: "draft:true", expr: ta(p(fDraft, "true")), want: list("F04")},
		{name: "draft:false", expr: ta(p(fDraft, "false")), want: except(all, "F04")},
		{name: "-draft:true", expr: ta(np(fDraft, "true")), want: except(all, "F04")},
		{name: "tracking:true includes ignored and unspecified", expr: ta(p(fTracking, "true")),
			want: except(all, "F02")},
		{name: "tracking:false", expr: ta(p(fTracking, "false")), want: list("F02")},
		{name: "-tracking:false", expr: ta(np(fTracking, "false")), want: except(all, "F02")},
		{name: "starred:true", expr: ta(p(fStarred, "true")), want: list("F01")},
		{name: "starred:false", expr: ta(p(fStarred, "false")), want: except(all, "F01")},
		{name: "-starred:true", expr: ta(np(fStarred, "true")), want: except(all, "F01")},
	}
}

func newCases(all []string) []evalCase {
	return []evalCase{
		{name: "new:item", expr: p(fNew, "item"), want: list("F05")},
		{name: "new:mention", expr: p(fNew, "mention"), want: list("F01")},
		{name: "new:comment", expr: p(fNew, "comment"), want: list("F01", "F05", "F08")},
		{name: "new:code", expr: p(fNew, "code"), want: list("F01", "F05")},
		{name: "new:noise", expr: p(fNew, "noise"), want: list("F04", "F08")},
		{name: "new:any excludes noise-only", expr: p(fNew, "any"), want: list("F01", "F05", "F08")},
		{name: "new:ANY", expr: p(fNew, "ANY"), want: list("F01", "F05", "F08")},
		{name: "-new:any in inbox", expr: np(fNew, "any"), want: list("F02", "F04", "F06", "F07", "F10", "F11")},
		{name: "-new:any with acked has no flags", expr: ta(np(fNew, "any")), want: except(all, "F01", "F05", "F08")},
		{name: "flags are independent", expr: andE(p(fNew, "mention"), p(fNew, "code")), want: list("F01")},
		{name: "noise and comment together", expr: andE(p(fNew, "noise"), p(fNew, "comment")), want: list("F08")},
		{name: "acked items have no flags", expr: andE(p(fTriage, "acked"), p(fNew, "any")), want: nil},
		{name: "acked items have no noise flag", expr: andE(p(fTriage, "acked"), p(fNew, "noise")), want: nil},
		{
			name: "unseen item counts its content",
			expr: andE(p(fNew, "item"), p(fNew, "comment"), p(fNew, "code")), want: list("F05"),
		},
		{name: "new:mention,noise", expr: p(fNew, "mention", "noise"), want: list("F01", "F04", "F08")},
		{name: "-new:noise keeps items with noise and real activity out", expr: np(fNew, "noise"),
			want: list("F01", "F02", "F05", "F06", "F07", "F10", "F11")},
	}
}

func identityCases(all []string) []evalCase {
	return []evalCase{
		{name: "repo equality", expr: ta(p(fRepo, "golang/go")), want: list("F03", "F04")},
		{name: "repo is case-insensitive", expr: ta(p(fRepo, "GOLANG/GO")), want: list("F03", "F04")},
		{name: "repo values are ORed", expr: ta(p(fRepo, "golang/go", "golang/tools")),
			want: list("F03", "F04", "F05")},
		{name: "repeated repo is AND", expr: ta(p(fRepo, "golang/go"), p(fRepo, "golang/tools")), want: nil},
		{name: "-repo", expr: ta(np(fRepo, "golang/go")), want: except(all, "F03", "F04")},
		{name: "-repo,repo", expr: ta(np(fRepo, "golang/go", "org2/app")),
			want: except(all, "F03", "F04", "F08", "F09", "F11")},
		{name: "repo stored mixed-case", expr: ta(p(fRepo, "kubernetes/enhancements")), want: list("F10")},
		{name: "repo is not validated", expr: ta(p(fRepo, "foo")), want: nil},
		{name: "org", expr: ta(p(fOrg, "kubernetes")), want: list("F01", "F02", "F10")},
		{name: "org is case-insensitive", expr: ta(p(fOrg, "KUBERNETES")), want: list("F01", "F02", "F10")},
		{name: "org needs the full owner", expr: ta(p(fOrg, "kube")), want: nil},
		{name: "-org", expr: ta(np(fOrg, "golang")), want: except(all, "F03", "F04", "F05")},
		{name: "author", expr: ta(p(fAuthor, "bob")), want: list("F02")},
		{name: "author strips @", expr: ta(p(fAuthor, "@bob")), want: list("F02")},
		{name: "author values are ORed", expr: ta(p(fAuthor, "alice", "carol")), want: list("F01", "F03")},
		{name: "author:@me", expr: ta(p(fAuthor, "@me")), want: list("F11")},
		{name: "author:@ME", expr: ta(p(fAuthor, "@ME")), want: list("F11")},
		{name: "author:@me without user", expr: ta(p(fAuthor, "@me")), noUser: true, want: nil},
		{name: "-author:@me without user", expr: ta(np(fAuthor, "@me")), noUser: true, want: all},
		{name: "author:@me,bob without user", expr: ta(p(fAuthor, "@me", "bob")), noUser: true, want: list("F02")},
		{name: "author:me is a literal login", expr: ta(p(fAuthor, "me")), want: list("F11")},
		{name: "-author", expr: ta(np(fAuthor, "frank")), want: except(all, "F06", "F07")},
		{name: "assignee:@me", expr: ta(p(fAssignee, "@me")), want: list("F01", "F05")},
		{name: "assignee:@me without user", expr: ta(p(fAssignee, "@me")), noUser: true, want: nil},
		{name: "assignee", expr: ta(p(fAssignee, "alice")), want: list("F02")},
		{name: "assignee values are ORed", expr: ta(p(fAssignee, "bob", "alice")), want: list("F02", "F05")},
		{name: "-assignee:@me", expr: ta(np(fAssignee, "@me")), want: except(all, "F01", "F05")},
		{name: "repeated assignee is AND", expr: ta(p(fAssignee, "@me"), p(fAssignee, "bob")), want: list("F05")},
	}
}

func nameCases(all []string) []evalCase {
	return []evalCase{
		{name: "milestone", expr: ta(p(fMilestone, "v1.32")), want: list("F01")},
		{name: "milestone is case-insensitive", expr: ta(p(fMilestone, "V1.32")), want: list("F01")},
		{name: "milestone mixed-case stored", expr: ta(p(fMilestone, "go1.24")), want: list("F03")},
		{name: "-milestone", expr: ta(np(fMilestone, "v1.32")), want: except(all, "F01")},
		{name: "milestone values are ORed", expr: ta(p(fMilestone, "v1.32", "kubernetes-1.0")),
			want: list("F01", "F10")},
		{name: "label case-insensitive", expr: ta(p(fLabel, "bug")), want: list("F01", "F07")},
		{name: "label with spaces", expr: ta(p(fLabel, "good first issue")), want: list("F01")},
		{name: "repeated label is AND", expr: ta(p(fLabel, "bug"), p(fLabel, "good first issue")), want: list("F01")},
		{name: "label values are ORed", expr: ta(p(fLabel, "bug", "enhancement")), want: list("F01", "F05", "F07")},
		{name: "-label", expr: ta(np(fLabel, "bug")), want: except(all, "F01", "F07")},
		{name: "-label,label is neither", expr: ta(np(fLabel, "bug", "enhancement")),
			want: except(all, "F01", "F05", "F07")},
		{name: "no:assignee", expr: ta(p(fNo, "assignee")),
			want: list("F03", "F04", "F06", "F07", "F08", "F09", "F10", "F11")},
		{name: "no:label", expr: ta(p(fNo, "label")), want: list("F03", "F04", "F06", "F08", "F09", "F11")},
		{name: "no:milestone includes empty title", expr: ta(p(fNo, "milestone")),
			want: list("F02", "F04", "F05", "F06", "F07", "F08", "F09", "F11")},
		{name: "-no:label", expr: ta(np(fNo, "label")), want: list("F01", "F02", "F05", "F07", "F10")},
		{name: "no:label,milestone", expr: ta(p(fNo, "label", "milestone")),
			want: list("F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09", "F11")},
	}
}

func textCases() []evalCase {
	return []evalCase{
		{name: "text word in title or body", expr: ta(p(fText, "flaky")), want: list("F01", "F08", "F11")},
		{name: "text is case-insensitive", expr: ta(p(fText, "FLAKY")), want: list("F01", "F08", "F11")},
		{name: "text words are ANDed in any order", expr: ta(p(fText, "flaky"), p(fText, "test")),
			want: list("F01", "F08", "F11")},
		{name: "quoted phrase matches exactly", expr: ta(p(fText, "flaky test")), want: list("F11")},
		{name: "in:title narrows", expr: ta(p(fIn, "title"), p(fText, "flaky")), want: list("F01")},
		{name: "in:body narrows", expr: ta(p(fIn, "body"), p(fText, "flaky")), want: list("F01", "F08", "F11")},
		{name: "in:title excludes body-only matches", expr: ta(p(fIn, "title"), p(fText, "arm64")), want: nil},
		{name: "in:title finds title-only matches", expr: ta(p(fIn, "title"), p(fText, "compiler")), want: list("F03")},
		{name: "in:body excludes title-only matches", expr: ta(p(fIn, "body"), p(fText, "compiler")), want: nil},
		{name: "in:title,body", expr: ta(p(fIn, "title", "body"), p(fText, "arm64")), want: list("F01")},
		{name: "repeated in is a union", expr: ta(p(fIn, "title"), p(fIn, "body"), p(fText, "arm64")),
			want: list("F01")},
		{name: "in alone matches everything", expr: ta(p(fIn, "title")), want: idsOf(coreFixtures())},
		{name: "#number", expr: ta(p(fText, "#123")), want: list("F10")},
		{name: "bare number", expr: ta(p(fText, "123")), want: list("F10")},
		{name: "number is not a prefix match", expr: ta(p(fText, "#12")), want: nil},
		{name: "number ignores in:", expr: ta(p(fIn, "title"), p(fText, "#123")), want: list("F10")},
		{name: "number also matches as substring", expr: ta(p(fText, "4567")), want: list("F11")},
		{name: "repo names are not searched", expr: ta(p(fText, "kubernetes")), want: nil},
		{name: "author names are not searched", expr: ta(p(fText, "gina")), want: nil},
		{name: "label names are not searched", expr: ta(p(fText, "enhancement")), want: nil},
		{name: "milestone names are not searched", expr: ta(p(fText, "v1.32")), want: nil},
		{name: "text values are ORed", expr: ta(p(fText, "typo", "arm64")), want: list("F01", "F10")},
		{name: "-text", expr: ta(np(fText, "flaky")),
			want: list("F02", "F03", "F04", "F05", "F06", "F07", "F09", "F10")},
	}
}

func nestingCases() []evalCase {
	return []evalCase{
		{
			name: "or of ands",
			expr: ta(orE(
				andE(p(fRepo, "golang/go"), p(fAuthor, "dave")),
				andE(p(fRepo, "kubernetes/minikube"), p(fAuthor, "bob")),
			)),
			want: list("F02", "F04"),
		},
		{
			name: "not of or",
			expr: ta(notE(orE(p(fRepo, "golang/go"), p(fRepo, "org2/app")))),
			want: list("F01", "F02", "F05", "F06", "F07", "F10"),
		},
		{
			name: "or with nested not",
			expr: ta(orE(p(fLabel, "bug"), andE(p(fType, "pr"), notE(p(fState, "open"))))),
			want: list("F01", "F03", "F07"),
		},
		{
			name: "or over triage scopes",
			expr: orE(andE(p(fNew, "any"), p(fRepo, "golang/tools")), andE(p(fTriage, "acked"), p(fRepo, "golang/go"))),
			want: list("F03", "F05"),
		},
		{name: "double negation", expr: ta(notE(notE(p(fType, "pr")))), want: list("F01", "F03", "F04", "F05", "F06")},
		{name: "not of empty and", expr: ta(notE(andE())), want: nil},
		{
			name: "nested and inside or inside and",
			expr: andE(p(fTriage, "all"), orE(andE(p(fOrg, "golang"), np(fDraft, "true")), p(fStarred, "true"))),
			want: list("F01", "F03", "F05"),
		},
	}
}

// edgeCases run over edgeFixtures.
func edgeCases() []evalCase {
	all := idsOf(edgeFixtures())
	return []evalCase{
		{name: "edge type:pr with unknown type number", expr: ta(p(fType, "pr")), want: list("E1", "E3", "E4")},
		{name: "edge -type:pr", expr: ta(np(fType, "pr")), want: list("E2", "E5", "E6")},
		{name: "edge not type:pr", expr: ta(notE(p(fType, "pr"))), want: list("E2", "E5", "E6")},
		{name: "edge type:issue", expr: ta(p(fType, "issue")), want: list("E2", "E5", "E6")},
		{name: "edge -type:issue", expr: ta(np(fType, "issue")), want: list("E1", "E3", "E4")},
		{name: "edge double not type", expr: ta(notE(notE(p(fType, "pr")))), want: list("E1", "E3", "E4")},
		{name: "edge state:open with unspecified", expr: ta(p(fState, "open")), want: list("E1", "E2", "E3", "E6")},
		{name: "edge -state:open", expr: ta(np(fState, "open")), want: list("E4", "E5")},
		{name: "edge state:merged", expr: ta(p(fState, "merged")), want: list("E4")},
		{name: "edge author mixed case", expr: ta(p(fAuthor, "alice")), want: list("E1", "E5")},
		{name: "edge author upper case", expr: ta(p(fAuthor, "ALICE")), want: list("E1", "E5")},
		{name: "edge author with @", expr: ta(p(fAuthor, "@alice")), want: list("E1", "E5")},
		{name: "edge -author keeps missing author", expr: ta(np(fAuthor, "alice")), want: list("E2", "E3", "E4", "E6")},
		{name: "edge non-ASCII author exact", expr: ta(p(fAuthor, "ZOË")), want: list("E2")},
		{name: "edge non-ASCII author ASCII-folded", expr: ta(p(fAuthor, "zoË")), want: list("E2")},
		{name: "edge non-ASCII letters are not folded", expr: ta(p(fAuthor, "zoë")), want: nil},
		{name: "edge -non-ASCII author", expr: ta(np(fAuthor, "ZOË")), want: except(all, "E2")},
		{name: "edge Kelvin sign is not k", expr: ta(p(fAuthor, "kate")), want: nil},
		{name: "edge -Kelvin sign is not k", expr: ta(np(fAuthor, "KATE")), want: all},
		{name: "edge Kelvin sign author exact", expr: ta(p(fAuthor, "\u212Aate")), want: list("E4")},
		{name: "edge org with underscore", expr: ta(p(fOrg, "my_org")), want: list("E1")},
		{name: "edge -org with underscore", expr: ta(np(fOrg, "my_org")), want: except(all, "E1")},
		{name: "edge org with percent", expr: ta(p(fOrg, "a%b")), want: list("E3")},
		{name: "edge -org with percent", expr: ta(np(fOrg, "a%b")), want: except(all, "E3")},
		{name: "edge org case-insensitive", expr: ta(p(fOrg, "OWNER")), want: list("E5", "E6")},
		{name: "edge repo case-insensitive", expr: ta(p(fRepo, "owner/repo")), want: list("E5", "E6")},
		{name: "edge -repo", expr: ta(np(fRepo, "owner/repo")), want: list("E1", "E2", "E3", "E4")},
		{name: "edge implicit inbox", expr: p(fRepo, "owner/repo"), want: list("E5")},
		{name: "edge or with unpushable child", expr: ta(orE(p(fLabel, "bug"), p(fRepo, "my_org/r"))),
			want: list("E1", "E5")},
		{name: "edge not or with unpushable child", expr: ta(notE(orE(p(fLabel, "bug"), p(fRepo, "my_org/r")))),
			want: list("E2", "E3", "E4", "E6")},
		{name: "edge and with unpushable child", expr: ta(p(fState, "open"), p(fLabel, "bug")), want: nil},
		{name: "edge not and with unpushable child", expr: ta(notE(andE(p(fState, "open"), p(fLabel, "bug")))),
			want: all},
		{name: "edge author:@me without user", expr: ta(p(fAuthor, "@me")), noUser: true, want: nil},
		{name: "edge -author:@me without user", expr: ta(np(fAuthor, "@me")), noUser: true, want: all},
		{name: "edge not author:@me without user", expr: ta(notE(p(fAuthor, "@me"))), noUser: true, want: all},
		{name: "edge many repo values", expr: ta(p(fRepo, manyRepos("my_org/r")...)), want: list("E1")},
		{name: "edge -many repo values", expr: ta(np(fRepo, manyRepos("my_org/r")...)), want: except(all, "E1")},
	}
}

// manyRepos returns more repository values than the prefilter binds, ending with extra.
func manyRepos(extra string) []string {
	const n = 600
	out := make([]string, 0, n+1)
	for i := range n {
		out = append(out, "filler/repo"+strconv.Itoa(i))
	}
	return append(out, extra)
}

// evalViews compiles c.expr and evaluates it over freshly built views of items.
func evalViews(c evalCase, items []*octodeckv1.Item) ([]*View, error) {
	q, err := Compile(c.expr, Options{CurrentUser: c.user()})
	if err != nil {
		return nil, err
	}
	views := NewViews(cloneItems(items), Env{CurrentUser: c.user(), KnownBots: testBots})
	return q.Filter(views), nil
}

// statusOf computes the single status the card shows, for property tests.
func statusOf(item *octodeckv1.Item) octodeckv1.ItemStatus {
	c := proto.CloneOf(item)
	logic.ClassifyCommentsForUser(testBots, testUser, c)
	return logic.CalculateStatus(c, testUser, testBots)
}
