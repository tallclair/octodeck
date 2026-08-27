package logger

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// ParseLevel converts a string to a [slog.Level].
func ParseLevel(levelStr string) slog.Level {
	switch strings.ToLower(levelStr) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Init sets up the global logger with a specific level and format.
func Init(level slog.Level, format string) {
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	switch strings.ToLower(format) {
	case "json":
		handler = slog.NewJSONHandler(os.Stdout, opts)
	case "text":
		handler = slog.NewTextHandler(os.Stdout, opts)
	default:
		// Default to JSON for machine-readability
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)
}

// InitWithWriter is for testing. It initializes the logger to write to the
// provided writer at the Debug level.
func InitWithWriter(w io.Writer) {
	opts := &slog.HandlerOptions{Level: slog.LevelDebug}
	handler := slog.NewJSONHandler(w, opts)
	logger := slog.New(handler)
	slog.SetDefault(logger)
}
