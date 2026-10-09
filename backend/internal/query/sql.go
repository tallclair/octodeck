package query

import (
	"slices"
	"strings"
	"unicode/utf8"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/database"
)

// maxPrefilterArgs caps the number of bound values in a prefilter. Larger queries fall back to a
// full scan, which is always correct and stays far below SQLite's variable limit.
const maxPrefilterArgs = 500

// maxPrefilterDepth caps the estimated expression depth of a prefilter (see sqlFrag.depth). SQLite
// rejects expressions deeper than 1000, and a chain "a OR b OR c ..." is parsed into a tree as deep
// as it is long, so wide and/or lists would otherwise turn a valid query into an SQL error. Deeper
// prefilters fall back to a full scan. Queries built by the dashboard stay far below this.
const maxPrefilterDepth = 100

// colRepo is the items table column holding "owner/name" (COLLATE NOCASE).
const colRepo = "repo"

// constKind marks a fragment that is a constant condition.
type constKind int

const (
	notConst constKind = iota
	constTrue
	constFalse
)

// sqlFrag is a translated subtree. exact means the SQL condition selects exactly the rows the
// subtree matches in memory; otherwise it selects a superset of them.
type sqlFrag struct {
	sql   string
	args  []any
	exact bool
	// konst is set when the fragment is exactly the constant TRUE or FALSE. Constants are folded
	// into their parents rather than emitted, so they never add to the size of the SQL.
	konst constKind
	// depth is an upper bound on the depth of the expression tree SQLite builds for sql, counting
	// one level per operator in a chain and per parenthesised or negated group.
	depth int
}

// Depth estimates (see sqlFrag.depth) of the fragments the translator emits.
const (
	// depthComparison is a comparison of a column with values ("state IN (...)", "type <> ?").
	depthComparison = 2
	// depthCollatedComparison is a comparison of a column with an explicit COLLATE.
	depthCollatedComparison = 3
	// depthNegation is added by "NOT (...)".
	depthNegation = 2
)

func fragTrue() sqlFrag  { return sqlFrag{sql: "1", exact: true, konst: constTrue, depth: 1} }
func fragFalse() sqlFrag { return sqlFrag{sql: "0", exact: true, konst: constFalse, depth: 1} }

// SQLPrefilter translates the query into a condition over the indexed item columns (repo, state,
// type, author_login) that selects a superset of the matching items. The full query is always
// re-evaluated in memory on the rows it returns, so it only ever narrows the candidate set and
// never decides membership (design §6). It returns nil (scan every row) when nothing can be
// pushed down, when the condition is always true, or when it would be too large for SQLite.
//
// The implicit triage scope, activity flags, text and every field stored only in the item blob are
// never pushed down. A subtree is pushed under not or or only if it is translated exactly, because
// negating a superset would drop real matches. NOT is safe in SQL's three-valued logic here because
// every pushed column is NOT NULL.
func SQLPrefilter(q *Query) *database.ItemFilter {
	f, ok := translate(q.root)
	if !ok || f.konst == constTrue || len(f.args) > maxPrefilterArgs || f.depth > maxPrefilterDepth {
		return nil
	}
	return &database.ItemFilter{Where: f.sql, Args: f.args}
}

// translate returns the SQL for a subtree, or ok=false if no part of it can be expressed.
func translate(n *Node) (sqlFrag, bool) {
	switch n.Kind {
	case KindTrue:
		return fragTrue(), true
	case KindFalse:
		return fragFalse(), true
	case KindPredicate:
		return translatePredicate(n.Pred)
	case KindAnd:
		return translateAnd(n.Children)
	case KindOr:
		return translateOr(n.Children)
	case KindNot:
		child, ok := translate(n.Children[0])
		if !ok || !child.exact {
			return sqlFrag{}, false
		}
		return negate(child), true
	}
	return sqlFrag{}, false
}

// negate negates an exact fragment, folding constants.
func negate(f sqlFrag) sqlFrag {
	switch f.konst {
	case constTrue:
		return fragFalse()
	case constFalse:
		return fragTrue()
	case notConst:
	}
	return sqlFrag{sql: "NOT (" + f.sql + ")", args: f.args, exact: true, depth: f.depth + depthNegation}
}

// translateAnd keeps the translatable conjuncts. Dropping a conjunct only widens the result, so the
// conjunction is still a superset; it is exact only if every child was translated exactly. TRUE
// conjuncts are dropped without loss, and a FALSE conjunct makes the whole conjunction FALSE.
func translateAnd(children []*Node) (sqlFrag, bool) {
	var parts []sqlFrag
	exact := true
	for _, c := range children {
		f, ok := translate(c)
		if !ok {
			exact = false
			continue
		}
		switch f.konst {
		case constFalse:
			return fragFalse(), true
		case constTrue:
			continue
		case notConst:
		}
		parts = append(parts, f)
		exact = exact && f.exact
	}
	if len(parts) == 0 {
		if exact {
			return fragTrue(), true
		}
		return sqlFrag{}, false
	}
	return joinFrags(parts, " AND ", exact), true
}

// translateOr requires every disjunct, since an untranslatable child could match any row, unless
// some disjunct is TRUE, which makes the whole disjunction TRUE. FALSE disjuncts are dropped.
func translateOr(children []*Node) (sqlFrag, bool) {
	parts := make([]sqlFrag, 0, len(children))
	translatable := true
	exact := true
	for _, c := range children {
		f, ok := translate(c)
		if !ok {
			translatable = false
			continue
		}
		switch f.konst {
		case constTrue:
			return fragTrue(), true
		case constFalse:
			continue
		case notConst:
		}
		parts = append(parts, f)
		exact = exact && f.exact
	}
	if !translatable {
		return sqlFrag{}, false
	}
	if len(parts) == 0 {
		return fragFalse(), true
	}
	return joinFrags(parts, " OR ", exact), true
}

// joinFrags joins non-constant fragments with op, parenthesising each.
func joinFrags(parts []sqlFrag, op string, exact bool) sqlFrag {
	sqls := make([]string, len(parts))
	var args []any
	depth := 0
	for i, f := range parts {
		sqls[i] = "(" + f.sql + ")"
		args = append(args, f.args...)
		depth = max(depth, f.depth+1)
	}
	return sqlFrag{sql: strings.Join(sqls, op), args: args, exact: exact, depth: depth + len(parts) - 1}
}

func translatePredicate(p *Predicate) (sqlFrag, bool) {
	pos, ok := positivePredicate(p)
	if !ok {
		return sqlFrag{}, false
	}
	if !p.Negated {
		return pos, true
	}
	if !pos.exact {
		return sqlFrag{}, false
	}
	return negate(pos), true
}

// positivePredicate translates the OR of a predicate's values, ignoring negation.
func positivePredicate(p *Predicate) (sqlFrag, bool) {
	switch p.Field {
	case octodeckv1.Field_FIELD_STATE:
		return stateSQL(p.Values), true
	case octodeckv1.Field_FIELD_TYPE:
		return typeSQL(p.Values), true
	case octodeckv1.Field_FIELD_REPO:
		// The repo column is COLLATE NOCASE, which folds ASCII exactly like identKey.
		return inSQL(colRepo, p.Values)
	case octodeckv1.Field_FIELD_AUTHOR:
		return inSQL("author_login COLLATE NOCASE", p.Values)
	case octodeckv1.Field_FIELD_ORG:
		return orgSQL(p.Values)
	case octodeckv1.Field_FIELD_UNSPECIFIED, octodeckv1.Field_FIELD_TRIAGE, octodeckv1.Field_FIELD_DRAFT,
		octodeckv1.Field_FIELD_TRACKING, octodeckv1.Field_FIELD_STARRED, octodeckv1.Field_FIELD_NEW,
		octodeckv1.Field_FIELD_ASSIGNEE, octodeckv1.Field_FIELD_MILESTONE, octodeckv1.Field_FIELD_LABEL,
		octodeckv1.Field_FIELD_NO, octodeckv1.Field_FIELD_IN, octodeckv1.Field_FIELD_TEXT:
		// Computed, stored only in the item blob, or (in) a modifier that must not become TRUE
		// under a negation.
		return sqlFrag{}, false
	}
	return sqlFrag{}, false
}

// stateSQL is exact: the state column stores the raw enum, and open includes unspecified while
// closed includes merged, exactly as matchState.
func stateSQL(values []string) sqlFrag {
	var states []int32
	add := func(ss ...octodeckv1.ItemState) {
		for _, s := range ss {
			if !slices.Contains(states, int32(s)) {
				states = append(states, int32(s))
			}
		}
	}
	for _, v := range values {
		switch v {
		case valueOpen:
			add(octodeckv1.ItemState_ITEM_STATE_UNSPECIFIED, octodeckv1.ItemState_ITEM_STATE_OPEN)
		case valueClosed:
			add(octodeckv1.ItemState_ITEM_STATE_CLOSED, octodeckv1.ItemState_ITEM_STATE_MERGED)
		case valueMerged:
			add(octodeckv1.ItemState_ITEM_STATE_MERGED)
		}
	}
	args := make([]any, len(states))
	for i, s := range states {
		args[i] = s
	}
	return sqlFrag{sql: "state IN (" + placeholders(len(args)) + ")", args: args, exact: true, depth: depthComparison}
}

// typeSQL is only a superset: items without a recorded type (or with an unknown type number) fall
// back to their URL, which is not a column. "pr" therefore only excludes rows recorded as issues,
// and "issue" only rows recorded as PRs.
func typeSQL(values []string) sqlFrag {
	parts := make([]string, 0, len(values))
	args := make([]any, 0, len(values))
	for _, v := range values {
		switch v {
		case valuePR:
			parts = append(parts, "type <> ?")
			args = append(args, int32(octodeckv1.ItemType_ITEM_TYPE_ISSUE))
		case valueIssue:
			parts = append(parts, "type <> ?")
			args = append(args, int32(octodeckv1.ItemType_ITEM_TYPE_PR))
		}
	}
	return sqlFrag{sql: strings.Join(parts, " OR "), args: args, exact: false, depth: len(parts) - 1 + depthComparison}
}

// inSQL compares an identifier column with the values. Values that can't be compared exactly (see
// pushableIdent) are not pushed down.
func inSQL(column string, values []string) (sqlFrag, bool) {
	args := make([]any, len(values))
	for i, v := range values {
		if !pushableIdent(v) {
			return sqlFrag{}, false
		}
		args[i] = v
	}
	sql := column + " IN (" + placeholders(len(args)) + ")"
	return sqlFrag{sql: sql, args: args, exact: true, depth: depthCollatedComparison}, true
}

// orgSQL matches repositories under each owner. SQLite's LIKE is ASCII case-insensitive, matching
// identKey; LIKE metacharacters in the owner are escaped so "my_org" doesn't match "myXorg".
func orgSQL(values []string) (sqlFrag, bool) {
	escaper := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	parts := make([]string, len(values))
	args := make([]any, len(values))
	for i, v := range values {
		if !pushableIdent(v) {
			return sqlFrag{}, false
		}
		parts[i] = `repo LIKE ? ESCAPE '\'`
		args[i] = escaper.Replace(v) + "/%"
	}
	depth := len(parts) - 1 + depthComparison
	return sqlFrag{sql: strings.Join(parts, " OR "), args: args, exact: true, depth: depth}, true
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// pushableIdent reports whether an identifier value compares in SQLite exactly as identKey does.
// Non-ASCII values are excluded as a guard against collation differences, and values containing
// NUL because NOCASE and LIKE stop comparing at the first NUL byte, so "a\x00b" would collate
// equal to "a\x00c".
func pushableIdent(s string) bool {
	for i := range len(s) {
		if s[i] >= utf8.RuneSelf || s[i] == 0 {
			return false
		}
	}
	return true
}
