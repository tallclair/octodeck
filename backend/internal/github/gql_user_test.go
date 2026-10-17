package github

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

func TestGqlUserToProto(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		wantType octodeckv1.UserType
	}{
		{
			name:     "GitHub App bot",
			json:     `{"__typename":"Bot","login":"kubernetes-prow","avatarUrl":"https://example.com/b.png"}`,
			wantType: octodeckv1.UserType_USER_TYPE_BOT,
		},
		{
			name:     "human user",
			json:     `{"__typename":"User","login":"tallclair","avatarUrl":"https://example.com/u.png"}`,
			wantType: octodeckv1.UserType_USER_TYPE_USER,
		},
		{
			name:     "machine user account is not a Bot type",
			json:     `{"__typename":"User","login":"k8s-ci-robot","avatarUrl":"https://example.com/r.png"}`,
			wantType: octodeckv1.UserType_USER_TYPE_USER,
		},
		{
			name:     "missing typename (cached data)",
			json:     `{"login":"someone","avatarUrl":"https://example.com/s.png"}`,
			wantType: octodeckv1.UserType_USER_TYPE_UNSPECIFIED,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var u gqlUser
			require.NoError(t, json.Unmarshal([]byte(tc.json), &u))
			got := u.toProto()
			assert.Equal(t, u.Login, got.GetLogin())
			assert.Equal(t, u.AvatarURL, got.GetAvatarUrl())
			assert.Equal(t, tc.wantType, got.GetType())
		})
	}
}

func TestGqlCommentAuthorCarriesBotType(t *testing.T) {
	// Comments parsed from a GraphQL response must propagate the author's Bot typename so that
	// the sync engine can discover GitHub App bots without relying on login heuristics.
	var c gqlComment
	require.NoError(t, json.Unmarshal([]byte(`{
		"databaseId": 42,
		"createdAt": "2026-10-16T12:00:00Z",
		"body": "This issue is currently awaiting triage.",
		"author": {"__typename": "Bot", "login": "kubernetes-prow", "avatarUrl": "https://example.com/b.png"}
	}`), &c))
	assert.Equal(t, octodeckv1.UserType_USER_TYPE_BOT, c.Author.toProto().GetType())
}
