package query

import (
	"fmt"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

// ValidationError reports an invalid query expression. Path identifies the offending node as a
// proto field path from the root Expr (for example "and.exprs[1].not.predicate.values[0]"); it is
// empty for the root itself.
type ValidationError struct {
	Path    string
	Message string
	// Field is the field of the offending predicate, if any.
	Field octodeckv1.Field
	// Value is the offending value, if any.
	Value string
}

func (e *ValidationError) Error() string {
	path := e.Path
	if path == "" {
		path = "<root>"
	}
	return fmt.Sprintf("invalid query at %s: %s", path, e.Message)
}

// Proto returns the error as an ExprError, for use as a connect error detail.
func (e *ValidationError) Proto() *octodeckv1.ExprError {
	b := octodeckv1.ExprError_builder{
		Path:    &e.Path,
		Message: &e.Message,
	}
	if e.Field != octodeckv1.Field_FIELD_UNSPECIFIED {
		b.Field = &e.Field
	}
	if e.Value != "" {
		b.Value = &e.Value
	}
	return b.Build()
}
