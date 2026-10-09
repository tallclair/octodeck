package query

import (
	"fmt"
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// maxDepth bounds the nesting depth of an expression. The UI only builds a flat AND of predicates,
// so this only rejects pathological requests.
const maxDepth = 32

// NodeKind is the kind of a normalised expression node.
type NodeKind int

const (
	// KindTrue matches every item (the empty query or an empty and).
	KindTrue NodeKind = iota
	// KindFalse matches no item (for example author:@me when the current user is unknown).
	KindFalse
	// KindPredicate matches according to Node.Pred.
	KindPredicate
	// KindAnd matches when every child matches.
	KindAnd
	// KindOr matches when any child matches.
	KindOr
	// KindNot matches when its single child does not.
	KindNot
)

// Node is a validated, normalised expression node.
type Node struct {
	Kind     NodeKind
	Children []*Node    // and / or: one or more; not: exactly one
	Pred     *Predicate // KindPredicate only

	// origin is the field of the predicate this node was compiled from, when the predicate
	// compiled to something other than a KindPredicate node (an unresolved author:@me becomes
	// KindFalse, or not(KindFalse) when negated). Facets use it to drop the field's own
	// predicates.
	origin octodeckv1.Field
}

// field returns the field of the predicate the node was compiled from, or FIELD_UNSPECIFIED if
// it is not a predicate. A not wrapping a single predicate is the predicate's field, since
// not(field:value) means the same as -field:value.
func (n *Node) field() octodeckv1.Field {
	switch {
	case n.Kind == KindPredicate:
		return n.Pred.Field
	case n.origin != octodeckv1.Field_FIELD_UNSPECIFIED:
		return n.origin
	case n.Kind == KindNot:
		return n.Children[0].field()
	}
	return octodeckv1.Field_FIELD_UNSPECIFIED
}

// Predicate is a validated predicate with canonical values.
type Predicate struct {
	Field octodeckv1.Field
	// Values are canonical: closed values are lower-case and legal (triage:all is expanded to
	// inbox,acked); open values are trimmed; author/assignee values have one leading "@" stripped
	// and "@me" resolved to the current user. Never empty.
	Values []string
	// Negated negates the OR of Values.
	Negated bool
}

// Options configures compilation.
type Options struct {
	// CurrentUser is the authenticated login that "@me" resolves to. Empty if unknown, in which
	// case "@me" matches nothing.
	CurrentUser string
}

// Query is a validated query, ready to evaluate.
type Query struct {
	root *Node
	// implicitInbox is set when the tree contains no triage predicate anywhere, so the implicit
	// triage:inbox scope applies (design §4.6).
	implicitInbox bool
	// text is the set of fields free-text terms search (from in: predicates; default title+body).
	text textFields
}

// textFields selects which item fields free-text terms are matched against.
type textFields struct {
	title, body bool
}

// Root returns the normalised expression tree, without the implicit triage scope.
func (q *Query) Root() *Node { return q.root }

// ImplicitInbox reports whether the implicit triage:inbox scope applies.
func (q *Query) ImplicitInbox() bool { return q.implicitInbox }

// compileState accumulates query-wide facts during compilation.
type compileState struct {
	opts      Options
	hasTriage bool
	inFields  textFields
	hasIn     bool
}

// Compile validates expr and converts it into a Query. A nil expr, or a root with no kind set, is
// the empty query. Invalid expressions return a *ValidationError identifying the offending node.
func Compile(expr *octodeckv1.Expr, opts Options) (*Query, error) {
	st := &compileState{opts: opts}
	root := &Node{Kind: KindTrue}
	if expr != nil && expr.WhichKind() != octodeckv1.Expr_Kind_not_set_case {
		var err error
		root, err = st.compileExpr(expr, "", 0, true)
		if err != nil {
			return nil, err
		}
	}
	q := &Query{root: root, implicitInbox: !st.hasTriage, text: textFields{title: true, body: true}}
	if st.hasIn {
		q.text = st.inFields
	}
	return q, nil
}

// joinPath appends a proto field path segment.
func joinPath(prefix, seg string) string {
	if prefix == "" {
		return seg
	}
	return prefix + "." + seg
}

// compileExpr compiles one Expr at path. topLevel is true for the root and for the direct children
// of a root and, which is where in: predicates are allowed.
func (st *compileState) compileExpr(e *octodeckv1.Expr, path string, depth int, topLevel bool) (*Node, error) {
	if depth > maxDepth {
		return nil, &ValidationError{
			Path:    path,
			Message: fmt.Sprintf("expression is nested too deeply (maximum depth %d)", maxDepth),
		}
	}
	if e == nil {
		return nil, &ValidationError{Path: path, Message: "expression kind is not set"}
	}
	switch e.WhichKind() {
	case octodeckv1.Expr_Predicate_case:
		return st.compilePredicate(e.GetPredicate(), joinPath(path, "predicate"), topLevel)
	case octodeckv1.Expr_And_case:
		return st.compileAnd(e.GetAnd(), joinPath(path, "and"), depth, path == "")
	case octodeckv1.Expr_Or_case:
		return st.compileOr(e.GetOr(), joinPath(path, "or"), depth)
	case octodeckv1.Expr_Not_case:
		child, err := st.compileExpr(e.GetNot(), joinPath(path, "not"), depth+1, false)
		if err != nil {
			return nil, err
		}
		return &Node{Kind: KindNot, Children: []*Node{child}}, nil
	case octodeckv1.Expr_Kind_not_set_case:
		return nil, &ValidationError{Path: path, Message: "expression kind is not set"}
	}
	return nil, &ValidationError{Path: path, Message: "unknown expression kind"}
}

// compileAnd compiles an and list. An empty and is true. isRoot is set when the and is the root
// expression, so its children are top level.
func (st *compileState) compileAnd(list *octodeckv1.ExprList, path string, depth int, isRoot bool) (*Node, error) {
	children, err := st.compileList(list, joinPath(path, "exprs"), depth, isRoot)
	if err != nil {
		return nil, err
	}
	if len(children) == 0 {
		return &Node{Kind: KindTrue}, nil
	}
	return &Node{Kind: KindAnd, Children: children}, nil
}

// compileOr compiles an or list, which must not be empty.
func (st *compileState) compileOr(list *octodeckv1.ExprList, path string, depth int) (*Node, error) {
	exprsPath := joinPath(path, "exprs")
	if len(list.GetExprs()) == 0 {
		return nil, &ValidationError{Path: exprsPath, Message: "or requires at least one expression"}
	}
	children, err := st.compileList(list, exprsPath, depth, false)
	if err != nil {
		return nil, err
	}
	return &Node{Kind: KindOr, Children: children}, nil
}

func (st *compileState) compileList(list *octodeckv1.ExprList, path string, depth int, topLevel bool) ([]*Node, error) {
	exprs := list.GetExprs()
	children := make([]*Node, 0, len(exprs))
	for i, child := range exprs {
		n, err := st.compileExpr(child, fmt.Sprintf("%s[%d]", path, i), depth+1, topLevel)
		if err != nil {
			return nil, err
		}
		children = append(children, n)
	}
	return children, nil
}

// compilePredicate validates and normalises one predicate.
func (st *compileState) compilePredicate(p *octodeckv1.Predicate, path string, topLevel bool) (*Node, error) {
	field := p.GetField()
	if !knownField(field) {
		return nil, &ValidationError{
			Path:    joinPath(path, "field"),
			Message: fmt.Sprintf("unknown field %d", int32(field)),
			Field:   field,
		}
	}
	if field == octodeckv1.Field_FIELD_IN {
		if err := validateIn(p, path, topLevel); err != nil {
			return nil, err
		}
	}
	values, err := st.canonicalValues(p, path)
	if err != nil {
		return nil, err
	}

	switch field {
	case octodeckv1.Field_FIELD_TRIAGE:
		st.hasTriage = true
	case octodeckv1.Field_FIELD_IN:
		st.recordIn(values)
	case octodeckv1.Field_FIELD_UNSPECIFIED, octodeckv1.Field_FIELD_STATE, octodeckv1.Field_FIELD_TYPE,
		octodeckv1.Field_FIELD_DRAFT, octodeckv1.Field_FIELD_TRACKING, octodeckv1.Field_FIELD_STARRED,
		octodeckv1.Field_FIELD_NEW, octodeckv1.Field_FIELD_REPO, octodeckv1.Field_FIELD_ORG,
		octodeckv1.Field_FIELD_AUTHOR, octodeckv1.Field_FIELD_ASSIGNEE, octodeckv1.Field_FIELD_MILESTONE,
		octodeckv1.Field_FIELD_LABEL, octodeckv1.Field_FIELD_NO, octodeckv1.Field_FIELD_TEXT:
	}

	if len(values) == 0 {
		// Every value was "@me" and the current user is unknown: the predicate matches nothing.
		n := &Node{Kind: KindFalse, origin: field}
		if p.GetNegated() {
			n = &Node{Kind: KindNot, Children: []*Node{n}, origin: field}
		}
		return n, nil
	}
	return &Node{
		Kind: KindPredicate,
		Pred: &Predicate{Field: field, Values: values, Negated: p.GetNegated()},
	}, nil
}

// validateIn checks the restrictions on in: predicates. in narrows the fields searched by every
// free-text term in the query, so it is only meaningful as a top-level condition and can't be
// negated.
func validateIn(p *octodeckv1.Predicate, path string, topLevel bool) error {
	if p.GetNegated() {
		return &ValidationError{
			Path:    joinPath(path, "negated"),
			Message: "in cannot be negated",
			Field:   octodeckv1.Field_FIELD_IN,
		}
	}
	if !topLevel {
		return &ValidationError{
			Path:    path,
			Message: "in must be a top-level predicate (the root, or a direct child of the root and)",
			Field:   octodeckv1.Field_FIELD_IN,
		}
	}
	return nil
}

func (st *compileState) recordIn(values []string) {
	st.hasIn = true
	for _, v := range values {
		switch v {
		case valueTitle:
			st.inFields.title = true
		case valueBody:
			st.inFields.body = true
		}
	}
}

// canonicalValues validates and normalises the values of p. It may return fewer values than p
// has when "@me" can't be resolved.
func (st *compileState) canonicalValues(p *octodeckv1.Predicate, path string) ([]string, error) {
	field := p.GetField()
	raw := p.GetValues()
	valuesPath := joinPath(path, "values")
	if len(raw) == 0 {
		return nil, &ValidationError{Path: valuesPath, Message: "at least one value is required", Field: field}
	}
	out := make([]string, 0, len(raw))
	for i, v := range raw {
		vpath := fmt.Sprintf("%s[%d]", valuesPath, i)
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return nil, &ValidationError{Path: vpath, Message: "value must not be empty", Field: field, Value: v}
		}
		canon, err := st.canonicalValue(field, trimmed, vpath)
		if err != nil {
			return nil, err
		}
		out = append(out, canon...)
	}
	return out, nil
}

// canonicalValue normalises one trimmed, non-empty value.
func (st *compileState) canonicalValue(field octodeckv1.Field, v, path string) ([]string, error) {
	if allowed, closed := ClosedValues(field); closed {
		lower := strings.ToLower(v)
		for _, a := range allowed {
			if lower != a {
				continue
			}
			if field == octodeckv1.Field_FIELD_TRIAGE && lower == valueAll {
				return []string{valueInbox, valueAcked}, nil
			}
			return []string{lower}, nil
		}
		msg := fmt.Sprintf("illegal value %q for field %s; allowed: %s",
			v, fieldName(field), strings.Join(allowed, ", "))
		if field == octodeckv1.Field_FIELD_IN {
			msg = fmt.Sprintf("in:%s is not supported; allowed: %s", v, strings.Join(allowed, ", "))
		}
		return nil, &ValidationError{Path: path, Message: msg, Field: field, Value: v}
	}
	if field != octodeckv1.Field_FIELD_AUTHOR && field != octodeckv1.Field_FIELD_ASSIGNEE {
		return []string{v}, nil
	}
	if strings.EqualFold(v, valueMe) {
		user := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(st.opts.CurrentUser), "@"))
		if user == "" {
			return nil, nil
		}
		return []string{user}, nil
	}
	login := strings.TrimSpace(strings.TrimPrefix(v, "@"))
	if login == "" {
		return nil, &ValidationError{Path: path, Message: "login must not be empty", Field: field, Value: v}
	}
	return []string{login}, nil
}
