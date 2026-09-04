package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
	"github.com/tallclair/octodeck/backend/internal/logger"
)

func setupTestLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	oldLogger := slog.Default()
	logger.InitWithWriter(&buf)
	t.Cleanup(func() {
		slog.SetDefault(oldLogger)
	})
	return &buf
}

type mockStreamingConn struct {
	spec connect.Spec
}

func (m *mockStreamingConn) Spec() connect.Spec {
	return m.spec
}

func (m *mockStreamingConn) Peer() connect.Peer {
	return connect.Peer{}
}

func (m *mockStreamingConn) Receive(any) error {
	return nil
}

func (m *mockStreamingConn) RequestHeader() http.Header {
	return http.Header{}
}

func (m *mockStreamingConn) Send(any) error {
	return nil
}

func (m *mockStreamingConn) ResponseHeader() http.Header {
	return http.Header{}
}

func (m *mockStreamingConn) ResponseTrailer() http.Header {
	return http.Header{}
}

func TestLoggingInterceptor_WrapUnary_ErrorLogsWithAttributes(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	handler := connect.NewUnaryHandler(
		"/octodeck.v1.OctoDeckService/GetItem",
		func(_ context.Context, _ *connect.Request[octodeckv1.GetItemRequest],
		) (*connect.Response[octodeckv1.GetItemResponse], error) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("item not found"))
		},
		connect.WithInterceptors(interceptor),
	)

	req := httptest.NewRequest(http.MethodPost, "/octodeck.v1.OctoDeckService/GetItem", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(t.Context(), middleware.RequestIDKey, "req-test-123"))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)

	var logEntry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
	assert.Equal(t, "ERROR", logEntry["level"])
	assert.Equal(t, "ConnectRPC procedure error", logEntry["msg"])
	assert.Equal(t, "/octodeck.v1.OctoDeckService/GetItem", logEntry["procedure"])
	assert.Equal(t, "not_found", logEntry["code"])
	assert.Contains(t, logEntry["error"], "item not found")
	assert.Equal(t, "req-test-123", logEntry["request_id"])
}

func TestLoggingInterceptor_WrapUnary_SuccessNoLog(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	handler := connect.NewUnaryHandler(
		"/octodeck.v1.OctoDeckService/GetItem",
		func(_ context.Context, _ *connect.Request[octodeckv1.GetItemRequest],
		) (*connect.Response[octodeckv1.GetItemResponse], error) {
			return connect.NewResponse(octodeckv1.GetItemResponse_builder{}.Build()), nil
		},
		connect.WithInterceptors(interceptor),
	)

	req := httptest.NewRequest(http.MethodPost, "/octodeck.v1.OctoDeckService/GetItem", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, buf.String(), "Expected no logs on successful unary call")
}

func TestLoggingInterceptor_WrapStreamingHandler_ErrorLogsWithAttributes(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	streamFunc := interceptor.WrapStreamingHandler(func(_ context.Context, _ connect.StreamingHandlerConn) error {
		return connect.NewError(connect.CodePermissionDenied, errors.New("insufficient permissions"))
	})

	ctx := context.WithValue(t.Context(), middleware.RequestIDKey, "stream-req-456")
	conn := &mockStreamingConn{
		spec: connect.Spec{
			Procedure: "/octodeck.v1.OctoDeckService/Sync",
		},
	}

	err := streamFunc(ctx, conn)
	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))

	var logEntry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
	assert.Equal(t, "ERROR", logEntry["level"])
	assert.Equal(t, "ConnectRPC procedure error", logEntry["msg"])
	assert.Equal(t, "/octodeck.v1.OctoDeckService/Sync", logEntry["procedure"])
	assert.Equal(t, "permission_denied", logEntry["code"])
	assert.Contains(t, logEntry["error"], "insufficient permissions")
	assert.Equal(t, "stream-req-456", logEntry["request_id"])
}

func TestLoggingInterceptor_WrapStreamingHandler_SuccessNoLog(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	streamFunc := interceptor.WrapStreamingHandler(func(_ context.Context, _ connect.StreamingHandlerConn) error {
		return nil
	})

	conn := &mockStreamingConn{
		spec: connect.Spec{
			Procedure: "/octodeck.v1.OctoDeckService/Sync",
		},
	}

	err := streamFunc(t.Context(), conn)
	require.NoError(t, err)
	assert.Empty(t, buf.String(), "Expected no logs on successful streaming call")
}

func TestLoggingInterceptor_WrapStreamingClient_PassThrough(t *testing.T) {
	interceptor := NewLoggingInterceptor()
	called := false
	dummy := func(_ context.Context, _ connect.Spec) connect.StreamingClientConn {
		called = true
		return nil
	}
	wrapped := interceptor.WrapStreamingClient(dummy)
	assert.NotNil(t, wrapped)
	_ = wrapped(t.Context(), connect.Spec{})
	assert.True(t, called)
}

func TestLoggingInterceptor_WithoutRequestID(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	unaryFunc := interceptor.WrapUnary(func(_ context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	})

	_, err := unaryFunc(t.Context(), connect.NewRequest(octodeckv1.GetItemRequest_builder{}.Build()))
	require.Error(t, err)

	var logEntry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
	assert.Equal(t, "ERROR", logEntry["level"])
	assert.Equal(t, "internal", logEntry["code"])
	assert.NotContains(t, logEntry, "request_id", "request_id should be omitted when absent")
}

func TestLoggingInterceptor_StandardError_CodeUnknown(t *testing.T) {
	buf := setupTestLogger(t)

	interceptor := NewLoggingInterceptor()
	unaryFunc := interceptor.WrapUnary(func(_ context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
		return nil, errors.New("raw standard error")
	})

	_, err := unaryFunc(t.Context(), connect.NewRequest(octodeckv1.GetItemRequest_builder{}.Build()))
	require.Error(t, err)

	var logEntry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
	assert.Equal(t, "unknown", logEntry["code"])
	assert.Equal(t, "raw standard error", logEntry["error"])
}

func TestServer_LoggingInterceptor_Integration(t *testing.T) {
	buf := setupTestLogger(t)

	db, client, addHeaders, _ := setupTestHandler(t)
	_ = db

	// 1. Call failing RPC: GetItem with non-existent ID
	req := connect.NewRequest(octodeckv1.GetItemRequest_builder{ItemId: config.Ptr("nonexistent-item-id")}.Build())
	addHeaders(req)

	_, err := client.GetItem(t.Context(), req)
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	// Verify log from interceptor
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	require.NotEmpty(t, lines)

	var lastLog map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &lastLog))
	assert.Equal(t, "ERROR", lastLog["level"])
	assert.Equal(t, "/octodeck.v1.OctoDeckService/GetItem", lastLog["procedure"])
	assert.Equal(t, "not_found", lastLog["code"])
	assert.NotEmpty(t, lastLog["request_id"]) // Populated by Chi RequestID middleware

	// 2. Call successful RPC: GetSyncStatus
	buf.Reset()
	statusReq := connect.NewRequest(octodeckv1.GetSyncStatusRequest_builder{}.Build())
	addHeaders(statusReq)

	statusResp, err := client.GetSyncStatus(t.Context(), statusReq)
	require.NoError(t, err)
	assert.NotNil(t, statusResp)
	assert.Empty(t, buf.String(), "Expected no logs on successful RPC")
}
