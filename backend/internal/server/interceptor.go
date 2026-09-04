package server

import (
	"context"
	"log/slog"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5/middleware"
)

// LoggingInterceptor intercepts ConnectRPC requests and logs handler failures with structured context.
type LoggingInterceptor struct{}

// NewLoggingInterceptor constructs a new ConnectRPC logging interceptor.
func NewLoggingInterceptor() connect.Interceptor {
	return &LoggingInterceptor{}
}

// WrapUnary wraps unary RPC handlers to log any returned errors.
func (i *LoggingInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		resp, err := next(ctx, req)
		if err != nil {
			var procedure string
			if req != nil {
				procedure = req.Spec().Procedure
			}
			logRPCError(ctx, procedure, err)
		}
		return resp, err
	}
}

// WrapStreamingClient is a pass-through for client-side streaming (unused on server).
func (i *LoggingInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

// WrapStreamingHandler wraps streaming RPC handlers to log any returned errors.
func (i *LoggingInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		err := next(ctx, conn)
		if err != nil {
			var procedure string
			if conn != nil {
				procedure = conn.Spec().Procedure
			}
			logRPCError(ctx, procedure, err)
		}
		return err
	}
}

// logRPCError logs a failed RPC invocation with structured attributes.
func logRPCError(ctx context.Context, procedure string, err error) {
	if err == nil {
		return
	}

	code := connect.CodeOf(err).String()
	errMsg := err.Error()

	if reqID := middleware.GetReqID(ctx); reqID != "" {
		slog.ErrorContext(ctx, "ConnectRPC procedure error",
			"procedure", procedure,
			"code", code,
			"error", errMsg,
			"request_id", reqID,
		)
		return
	}

	slog.ErrorContext(ctx, "ConnectRPC procedure error",
		"procedure", procedure,
		"code", code,
		"error", errMsg,
	)
}
