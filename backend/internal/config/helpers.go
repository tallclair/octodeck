package config

// Ptr returns a pointer to the given value.
// TODO(go1.26): Replace with new(T) once Go 1.26 is released.
func Ptr[T any](v T) *T {
	return &v
}
