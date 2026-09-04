package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

// TestChallenger_LoggingInterceptor_AllConnectCodes tests that the logging interceptor
// properly intercepts and logs all 16 standard Connect error codes with the expected
// slog attributes, error message, and procedure name.
func TestChallenger_LoggingInterceptor_AllConnectCodes(t *testing.T) {
	connectCodes := []struct {
		code       connect.Code
		codeString string
	}{
		{connect.CodeCanceled, "canceled"},
		{connect.CodeUnknown, "unknown"},
		{connect.CodeInvalidArgument, "invalid_argument"},
		{connect.CodeDeadlineExceeded, "deadline_exceeded"},
		{connect.CodeNotFound, "not_found"},
		{connect.CodeAlreadyExists, "already_exists"},
		{connect.CodePermissionDenied, "permission_denied"},
		{connect.CodeResourceExhausted, "resource_exhausted"},
		{connect.CodeFailedPrecondition, "failed_precondition"},
		{connect.CodeAborted, "aborted"},
		{connect.CodeOutOfRange, "out_of_range"},
		{connect.CodeUnimplemented, "unimplemented"},
		{connect.CodeInternal, "internal"},
		{connect.CodeUnavailable, "unavailable"},
		{connect.CodeDataLoss, "data_loss"},
		{connect.CodeUnauthenticated, "unauthenticated"},
	}

	for _, cc := range connectCodes {
		t.Run(cc.codeString, func(t *testing.T) {
			buf := setupTestLogger(t)

			interceptor := NewLoggingInterceptor()
			handler := connect.NewUnaryHandler(
				"/octodeck.v1.OctoDeckService/TestEndpoint",
				func(_ context.Context, _ *connect.Request[octodeckv1.GetItemRequest],
				) (*connect.Response[octodeckv1.GetItemResponse], error) {
					return nil, connect.NewError(cc.code, fmt.Errorf("simulated error for %s", cc.codeString))
				},
				connect.WithInterceptors(interceptor),
			)

			targetURL := "/octodeck.v1.OctoDeckService/TestEndpoint"
			req := httptest.NewRequest(http.MethodPost, targetURL, strings.NewReader("{}"))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(context.WithValue(t.Context(), middleware.RequestIDKey, "test-req-"+cc.codeString))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			// Parse the emitted JSON log
			var logEntry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry), "Log must be valid JSON: %s", buf.String())
			assert.Equal(t, "ERROR", logEntry["level"])
			assert.Equal(t, "ConnectRPC procedure error", logEntry["msg"])
			assert.Equal(t, targetURL, logEntry["procedure"])
			assert.Equal(t, cc.codeString, logEntry["code"])
			assert.Contains(t, logEntry["error"], fmt.Sprintf("simulated error for %s", cc.codeString))
			assert.Equal(t, "test-req-"+cc.codeString, logEntry["request_id"])
		})
	}
}

// TestChallenger_LoggingInterceptor_NilSafeguards tests nil request and connection handling
// to ensure no nil-pointer dereferences occur.
func TestChallenger_LoggingInterceptor_NilSafeguards(t *testing.T) {
	t.Run("Unary with nil AnyRequest", func(t *testing.T) {
		buf := setupTestLogger(t)

		interceptor := NewLoggingInterceptor()
		unaryFunc := interceptor.WrapUnary(func(_ context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
			return nil, connect.NewError(connect.CodeInternal, errors.New("unary nil req test"))
		})

		_, err := unaryFunc(t.Context(), nil)
		require.Error(t, err)

		var logEntry map[string]any
		require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
		assert.Equal(t, "ERROR", logEntry["level"])
		assert.Empty(t, logEntry["procedure"])
		assert.Equal(t, "internal", logEntry["code"])
		assert.Contains(t, logEntry["error"], "unary nil req test")
	})

	t.Run("Streaming with nil StreamingHandlerConn", func(t *testing.T) {
		buf := setupTestLogger(t)

		interceptor := NewLoggingInterceptor()
		streamFunc := interceptor.WrapStreamingHandler(func(_ context.Context, _ connect.StreamingHandlerConn) error {
			return connect.NewError(connect.CodeUnavailable, errors.New("stream nil conn test"))
		})

		err := streamFunc(t.Context(), nil)
		require.Error(t, err)

		var logEntry map[string]any
		require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
		assert.Equal(t, "ERROR", logEntry["level"])
		assert.Empty(t, logEntry["procedure"])
		assert.Equal(t, "unavailable", logEntry["code"])
		assert.Contains(t, logEntry["error"], "stream nil conn test")
	})
}

// TestChallenger_LoggingInterceptor_StandardErrorWrapping tests wrapped error chains
// and non-Connect standard Go errors.
func TestChallenger_LoggingInterceptor_StandardErrorWrapping(t *testing.T) {
	connectErr := connect.NewError(connect.CodePermissionDenied, errors.New("denied"))
	testCases := []struct {
		name         string
		err          error
		expectedCode string
		expectedMsg  string
	}{
		{
			name:         "Standard errors.New",
			err:          errors.New("standard error: database disk full"),
			expectedCode: "unknown",
			expectedMsg:  "standard error: database disk full",
		},
		{
			name:         "Deeply wrapped standard error",
			err:          fmt.Errorf("layer 1: %w", fmt.Errorf("layer 2: %w", errors.New("root cause"))),
			expectedCode: "unknown",
			expectedMsg:  "layer 1: layer 2: root cause",
		},
		{
			name:         "Wrapped Connect error",
			err:          fmt.Errorf("handler wrapper: %w", connectErr),
			expectedCode: "permission_denied",
			expectedMsg:  "handler wrapper: permission_denied: denied",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			buf := setupTestLogger(t)

			interceptor := NewLoggingInterceptor()
			unaryHandler := func(_ context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
				return nil, tc.err
			}
			unaryFunc := interceptor.WrapUnary(unaryHandler)

			_, err := unaryFunc(t.Context(), connect.NewRequest(octodeckv1.GetItemRequest_builder{}.Build()))
			require.Error(t, err)

			var logEntry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
			assert.Equal(t, "ERROR", logEntry["level"])
			assert.Equal(t, tc.expectedCode, logEntry["code"])
			assert.Equal(t, tc.expectedMsg, logEntry["error"])
		})
	}
}

// TestChallenger_LoggingInterceptor_StreamingErrors tests streaming procedures with context
// cancellation, deadline exceeded, and normal completion.
func TestChallenger_LoggingInterceptor_StreamingErrors(t *testing.T) {
	streamTestCases := []struct {
		name         string
		streamErr    error
		expectedCode string
	}{
		{
			name:         "Streaming Connect CodeCanceled error",
			streamErr:    connect.NewError(connect.CodeCanceled, context.Canceled),
			expectedCode: "canceled",
		},
		{
			name:         "Streaming raw context cancellation logs code unknown",
			streamErr:    context.Canceled,
			expectedCode: "unknown",
		},
		{
			name:         "Streaming Connect CodeDeadlineExceeded error",
			streamErr:    connect.NewError(connect.CodeDeadlineExceeded, context.DeadlineExceeded),
			expectedCode: "deadline_exceeded",
		},
	}

	for _, tc := range streamTestCases {
		t.Run(tc.name, func(t *testing.T) {
			buf := setupTestLogger(t)

			interceptor := NewLoggingInterceptor()
			handler := func(_ context.Context, _ connect.StreamingHandlerConn) error {
				return tc.streamErr
			}
			streamFunc := interceptor.WrapStreamingHandler(handler)

			conn := &mockStreamingConn{
				spec: connect.Spec{
					Procedure: "/octodeck.v1.OctoDeckService/Sync",
				},
			}

			err := streamFunc(t.Context(), conn)
			require.Error(t, err)

			var logEntry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
			assert.Equal(t, "ERROR", logEntry["level"])
			assert.Equal(t, "/octodeck.v1.OctoDeckService/Sync", logEntry["procedure"])
			assert.Equal(t, tc.expectedCode, logEntry["code"])
		})
	}

	t.Run("Streaming success emits zero logs", func(t *testing.T) {
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
		assert.Empty(t, buf.String())
	})
}

// TestChallenger_IsGitHubScopeError_Adversarial tests edge cases, rate limits, SAML headers,
// multiple error items, and mixed error responses for isGitHubScopeError.
func TestChallenger_IsGitHubScopeError_Adversarial(t *testing.T) {
	headersWithMissingScope := make(http.Header)
	headersWithMissingScope.Set("X-Accepted-Oauth-Scopes", "notifications")
	headersWithMissingScope.Set("X-Oauth-Scopes", "repo, read:org")

	// Test non-canonical / mixed-case map headers directly
	headersWithUpperMissingScope := http.Header{
		"X-Accepted-Oauth-Scopes": []string{"NOTIFICATIONS"},
		"X-Oauth-Scopes":          []string{"REPO, READ:ORG"},
	}

	headersWithSAML := make(http.Header)
	headersWithSAML.Set("X-Github-Sso", "required; url=https://github.com/orgs/my-org/sso?authorization_request=abc")

	headersWithSAMLAndMissingScope := make(http.Header)
	headersWithSAMLAndMissingScope.Set(
		"X-Github-Sso",
		"required; url=https://github.com/orgs/my-org/sso?authorization_request=abc",
	)
	headersWithSAMLAndMissingScope.Set("X-Accepted-Oauth-Scopes", "notifications")
	headersWithSAMLAndMissingScope.Set("X-Oauth-Scopes", "repo")

	tests := []struct {
		name     string
		err      error
		expected bool
	}{
		// Rate limit tests - MUST return false!
		{
			name: "HTTP 403 Rate Limit - standard message",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Message:    "API rate limit exceeded for user ID 12345",
			},
			expected: false,
		},
		{
			name: "HTTP 403 Secondary Rate Limit",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Message:    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
			},
			expected: false,
		},
		{
			name: "HTTP 403 Rate Limit with missing scope header present",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithMissingScope,
				Message:    "API rate limit exceeded for user ID 12345",
			},
			expected: false,
		},
		{
			name: "HTTP 429 Too Many Requests",
			err: &api.HTTPError{
				StatusCode: http.StatusTooManyRequests,
				Message:    "Too Many Requests",
			},
			expected: false,
		},
		{
			name: "GraphQL error with RATE_LIMITED type",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "RATE_LIMITED",
						Message: "API rate limit exceeded",
					},
				},
			},
			expected: false,
		},
		{
			name:     "Rate limit in error string with uppercase",
			err:      errors.New("API RATE LIMIT EXCEEDED FOR USER"),
			expected: false,
		},

		// SAML headers & messages
		{
			name: "HTTP 403 with SAML header and SAML message",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithSAML,
				Message:    "Resource protected by organization SAML enforcement.",
			},
			expected: true,
		},
		{
			name: "HTTP 403 with SAML header and missing scope header",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithSAMLAndMissingScope,
				Message:    "Forbidden",
			},
			expected: true,
		},
		{
			name: "GraphQL error with SAML enforcement message",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "FORBIDDEN",
						Message: "Resource protected by organization SAML enforcement. Must grant OAuth token access.",
					},
				},
			},
			expected: true,
		},

		// Header casing variations
		{
			name: "Uppercase OAuth scope headers",
			err: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Headers:    headersWithUpperMissingScope,
				Message:    "Forbidden",
			},
			expected: true,
		},

		// Deeply wrapped errors
		{
			name: "5-layer wrapped GraphQL scope error",
			err: fmt.Errorf("wrap 1: %w",
				fmt.Errorf("wrap 2: %w",
					fmt.Errorf("wrap 3: %w",
						fmt.Errorf("wrap 4: %w",
							fmt.Errorf("wrap 5: %w", &api.GraphQLError{
								Errors: []api.GraphQLErrorItem{
									{
										Type:    "FORBIDDEN",
										Message: "The 'notifications' scope is required",
									},
								},
							}))))),
			expected: true,
		},
		{
			name: "3-layer wrapped context.Canceled",
			err: fmt.Errorf("wrap 1: %w",
				fmt.Errorf("wrap 2: %w",
					fmt.Errorf("wrap 3: %w", context.Canceled))),
			expected: false,
		},
		{
			name: "3-layer wrapped context.DeadlineExceeded",
			err: fmt.Errorf("wrap 1: %w",
				fmt.Errorf("wrap 2: %w",
					fmt.Errorf("wrap 3: %w", context.DeadlineExceeded))),
			expected: false,
		},

		// Multiple error items in GraphQL
		{
			name: "GraphQL with multiple scope-related errors",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "FORBIDDEN",
						Message: "Insufficient scope: notifications",
					},
					{
						Type:    "FORBIDDEN",
						Message: "The 'notifications' scope is required",
					},
				},
			},
			expected: true,
		},
		{
			name: "GraphQL with non-scope error followed by scope error",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "ERROR",
						Message: "Something generic happened",
					},
					{
						Type:    "FORBIDDEN",
						Message: "The 'notifications' scope is required to access updateSubscription",
					},
				},
			},
			expected: true,
		},
		{
			name: "GraphQL rate limited error even if FORBIDDEN type",
			err: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "FORBIDDEN",
						Message: "Rate limit exceeded for user",
					},
				},
			},
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			actual := isGitHubScopeError(tc.err)
			assert.Equal(t, tc.expected, actual, "isGitHubScopeError(%v)", tc.err)
		})
	}
}

// TestChallenger_UpdateSubscription_SimulatedErrors tests the UpdateSubscription ConnectRPC endpoint
// against various simulated GitHub errors (rate limits, 500s, SAML, etc.) to verify proper
// ConnectRPC error codes, messages, and state preservation.
func TestChallenger_UpdateSubscription_SimulatedErrors(t *testing.T) {
	testCases := []struct {
		name           string
		ghErr          error
		expectedCode   connect.Code
		expectedMsgSub string
		isScopeError   bool
	}{
		{
			name: "GitHub returns 403 Rate Limit",
			ghErr: &api.HTTPError{
				StatusCode: http.StatusForbidden,
				Message:    "API rate limit exceeded",
			},
			expectedCode:   connect.CodeInternal,
			expectedMsgSub: "failed to update subscription on GitHub",
			isScopeError:   false,
		},
		{
			name:           "GitHub returns Secondary Rate Limit",
			ghErr:          errors.New("You have exceeded a secondary rate limit. Please wait a few minutes."),
			expectedCode:   connect.CodeInternal,
			expectedMsgSub: "failed to update subscription on GitHub",
			isScopeError:   false,
		},
		{
			name: "GitHub returns 502 Bad Gateway",
			ghErr: &api.HTTPError{
				StatusCode: http.StatusBadGateway,
				Message:    "Bad Gateway",
			},
			expectedCode:   connect.CodeInternal,
			expectedMsgSub: "failed to update subscription on GitHub",
			isScopeError:   false,
		},
		{
			name: "GitHub returns GraphQL FORBIDDEN scope error",
			ghErr: &api.GraphQLError{
				Errors: []api.GraphQLErrorItem{
					{
						Type:    "FORBIDDEN",
						Message: "The 'notifications' scope is required",
					},
				},
			},
			expectedCode:   connect.CodePermissionDenied,
			expectedMsgSub: "gh auth refresh -s notifications",
			isScopeError:   true,
		},
		{
			name:           "GitHub returns organization SAML enforcement error",
			ghErr:          errors.New("Resource protected by organization SAML enforcement."),
			expectedCode:   connect.CodePermissionDenied,
			expectedMsgSub: "gh auth refresh -s notifications",
			isScopeError:   true,
		},
		{
			name:           "GitHub returns Node resolution error",
			ghErr:          errors.New("Could not resolve to a node with the global id of 'PR_test'"),
			expectedCode:   connect.CodeInternal,
			expectedMsgSub: "failed to update subscription on GitHub",
			isScopeError:   false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			mockGH := &mockGitHubClient{
				authenticated: true,
				updateSubscriptionFn: func(_ context.Context, _ string, _ octodeckv1.SubscriptionState) error {
					return tc.ghErr
				},
			}

			db, client, addHeaders, _ := setupTestHandlerWithGH(t, mockGH)

			itemID := "PR_challenger_" + strings.ReplaceAll(tc.name, " ", "_")
			initialItem := octodeckv1.Item_builder{
				Id:                 config.Ptr(itemID),
				Repo:               config.Ptr("owner/repo"),
				Number:             config.Ptr(int32(200)),
				Type:               config.Ptr(octodeckv1.ItemType_ITEM_TYPE_PR),
				ViewerSubscription: config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED),
				UpdatedAt:          timestamppb.Now(),
			}.Build()
			require.NoError(t, db.SaveItems(t.Context(), []*octodeckv1.Item{initialItem}))

			req := connect.NewRequest(octodeckv1.UpdateSubscriptionRequest_builder{
				ItemId: config.Ptr(itemID),
				State:  config.Ptr(octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_SUBSCRIBED),
			}.Build())
			addHeaders(req)

			_, err := client.UpdateSubscription(t.Context(), req)
			require.Error(t, err)

			// Assert ConnectRPC error code
			actualCode := connect.CodeOf(err)
			assert.Equal(t, tc.expectedCode, actualCode, "Expected code %v, got %v", tc.expectedCode, actualCode)

			// Assert message contents
			assert.Contains(t, err.Error(), tc.expectedMsgSub)

			if tc.isScopeError {
				assert.Contains(t, err.Error(), "GitHub token lacks 'notifications' scope")
			}

			// Ensure SQLite database state was preserved (remains UNSUBSCRIBED)
			persisted, err := db.GetItem(t.Context(), itemID)
			require.NoError(t, err)
			assert.Equal(t,
				octodeckv1.SubscriptionState_SUBSCRIPTION_STATE_UNSUBSCRIBED,
				persisted.GetViewerSubscription(),
				"Database viewer_subscription must remain UNSUBSCRIBED on error",
			)
		})
	}
}

// TestChallenger_SyncRPC_E2E_StreamingInterceptor tests Sync procedure streaming via full HTTP server:
// 1. Successful stream emits zero error logs.
// 2. Failing sync engine emits internal error log with procedure name and request ID.
// 3. Client context cancellation during stream logs canceled or internal error.
func TestChallenger_SyncRPC_E2E_StreamingInterceptor(t *testing.T) {
	t.Run("Successful Sync emits zero logs", func(t *testing.T) {
		buf := setupTestLogger(t)

		_, client, addHeaders, _ := setupTestHandler(t)
		buf.Reset() // Clear migration logs from setup

		syncReq := connect.NewRequest(octodeckv1.SyncRequest_builder{}.Build())
		addHeaders(syncReq)

		stream, err := client.Sync(t.Context(), syncReq)
		require.NoError(t, err)
		require.NotNil(t, stream)

		msgCount := 0
		for stream.Receive() {
			msgCount++
			assert.NotEmpty(t, stream.Msg().GetMessage())
		}
		require.NoError(t, stream.Err())
		assert.Equal(t, 2, msgCount, "Expected 2 sync stages (fetching and complete)")

		assert.Empty(t, buf.String(), "Successful streaming Sync must emit zero error logs")
	})

	t.Run("Failing Sync logs procedure and error with request ID", func(t *testing.T) {
		buf := setupTestLogger(t)

		_, client, addHeaders, mockSync := setupTestHandler(t)
		mockSync.err = errors.New("simulated sync engine failure")
		buf.Reset() // Clear migration logs from setup

		syncReq := connect.NewRequest(octodeckv1.SyncRequest_builder{}.Build())
		addHeaders(syncReq)

		stream, err := client.Sync(t.Context(), syncReq)
		require.NoError(t, err)
		require.NotNil(t, stream)

		// First message (STAGE_FETCHING) should succeed
		assert.True(t, stream.Receive())
		assert.Equal(t, "Starting sync...", stream.Msg().GetMessage())

		// Second receive should fail because ForceSync returned an error
		assert.False(t, stream.Receive())
		require.Error(t, stream.Err())
		assert.Equal(t, connect.CodeInternal, connect.CodeOf(stream.Err()))

		// Check the emitted log entry
		var logEntry map[string]any
		require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
		assert.Equal(t, "ERROR", logEntry["level"])
		assert.Equal(t, "/octodeck.v1.OctoDeckService/Sync", logEntry["procedure"])
		assert.Equal(t, "internal", logEntry["code"])
		assert.Contains(t, logEntry["error"], "simulated sync engine failure")
		assert.NotEmpty(t, logEntry["request_id"])
	})

	t.Run("Canceled client context on stream invocation", func(t *testing.T) {
		buf := setupTestLogger(t)

		_, client, addHeaders, _ := setupTestHandler(t)
		buf.Reset()

		ctx, cancel := context.WithCancel(t.Context())
		cancel() // Cancel immediately before stream call

		syncReq := connect.NewRequest(octodeckv1.SyncRequest_builder{}.Build())
		addHeaders(syncReq)

		stream, err := client.Sync(ctx, syncReq)
		if err == nil {
			for stream.Receive() {
			}
			err = stream.Err()
		}
		require.Error(t, err)
		assert.Equal(t, connect.CodeCanceled, connect.CodeOf(err))

		// If server processed the canceled request, verify log
		if buf.Len() > 0 {
			var logEntry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &logEntry))
			assert.Equal(t, "ERROR", logEntry["level"])
			assert.Equal(t, "/octodeck.v1.OctoDeckService/Sync", logEntry["procedure"])
		}
	})
}

// generateFuzzError builds a synthetic nested error based on generation parameters.
func generateFuzzError(idx, status int, accepted, current, msg, gqlType string, depth int) error {
	var testErr error
	switch idx % 4 {
	case 0:
		hdr := make(http.Header)
		if accepted != "" {
			hdr.Set("X-Accepted-Oauth-Scopes", accepted)
		}
		if current != "" {
			hdr.Set("X-Oauth-Scopes", current)
		}
		testErr = &api.HTTPError{
			StatusCode: status,
			Headers:    hdr,
			Message:    msg,
		}
	case 1:
		testErr = &api.GraphQLError{
			Errors: []api.GraphQLErrorItem{
				{
					Type:    gqlType,
					Message: msg,
				},
			},
		}
	case 2:
		testErr = errors.New(msg)
	case 3:
		if idx%2 == 0 {
			testErr = context.Canceled
		} else {
			testErr = context.DeadlineExceeded
		}
	}

	for d := range depth {
		testErr = fmt.Errorf("wrap %d: %w", d, testErr)
	}
	return testErr
}

// TestChallenger_Fuzzing_Invariants runs 5,000 randomized property tests
// verifying invariants across edge cases, random headers, error types, and nested errors.
func TestChallenger_Fuzzing_Invariants(t *testing.T) {
	statusCodes := []int{200, 301, 400, 401, 403, 404, 429, 500, 502, 503}
	acceptedScopesList := []string{
		"", "repo", "notifications", "repo, notifications", "repo, read:org", "NOTIFICATIONS",
	}
	currentScopesList := []string{
		"", "repo", "notifications", "repo, notifications", "repo, read:org", "read:org", "NOTIFICATIONS",
	}
	messagesList := []string{
		"", "Forbidden", "Unauthorized", "API rate limit exceeded for user ID 12345",
		"You have exceeded a secondary rate limit", "Resource not accessible by integration",
		"Resource protected by organization SAML enforcement.",
		"The 'notifications' scope is required to access this resource",
		"Could not resolve to a node with the global id of 'PR_123'", "Not Found",
		"Internal Server Error", "missing required oauth scope: notifications",
		"Rate limit exceeded while checking notifications scope",
	}
	gqlTypes := []string{"FORBIDDEN", "NOT_FOUND", "RATE_LIMITED", "ERROR", "", "UNAUTHORIZED", "INTERNAL"}

	const iterations = 5000

	for i := range iterations {
		status := statusCodes[(i*7)%len(statusCodes)]
		accepted := acceptedScopesList[(i*13)%len(acceptedScopesList)]
		current := currentScopesList[(i*17)%len(currentScopesList)]
		msg := messagesList[(i*19)%len(messagesList)]
		gqlType := gqlTypes[(i*23)%len(gqlTypes)]
		nestingDepth := i % 6

		testErr := generateFuzzError(i, status, accepted, current, msg, gqlType, nestingDepth)

		// Invariant 1: Must never panic
		var result bool
		assert.NotPanics(t, func() {
			result = isGitHubScopeError(testErr)
		})

		errStr := strings.ToLower(testErr.Error())

		// Invariant 2: Rate limits MUST return false
		if strings.Contains(errStr, "rate limit") {
			assert.False(t, result, "Rate limit error must return false: %s", testErr.Error())
		}

		// Invariant 3: Node resolution / not found MUST return false
		if strings.Contains(errStr, "could not resolve to a node") || strings.Contains(errStr, "not found") {
			assert.False(t, result, "Node resolution / not found error must return false: %s", testErr.Error())
		}

		// Invariant 4: Context errors MUST return false
		if errors.Is(testErr, context.Canceled) || errors.Is(testErr, context.DeadlineExceeded) {
			assert.False(t, result, "Context error must return false: %s", testErr.Error())
		}
	}
}
