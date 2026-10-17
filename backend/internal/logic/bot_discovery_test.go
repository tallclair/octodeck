package logic

import (
	"testing"

	"github.com/stretchr/testify/assert"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

const (
	userType = octodeckv1.UserType_USER_TYPE_USER
	botType  = octodeckv1.UserType_USER_TYPE_BOT
)

func testComment(login string, t octodeckv1.UserType) *octodeckv1.Comment {
	return octodeckv1.Comment_builder{Author: testUser(login, t)}.Build()
}

func testUser(login string, userType octodeckv1.UserType) *octodeckv1.User {
	return octodeckv1.User_builder{
		Login: config.Ptr(login),
		Type:  config.Ptr(userType),
	}.Build()
}

func TestExtractBotsFromItems(t *testing.T) {
	item := octodeckv1.Item_builder{
		Author: testUser("alice", octodeckv1.UserType_USER_TYPE_USER),
		Comments: []*octodeckv1.Comment{
			// GitHub App bot whose login doesn't match any name heuristic.
			testComment("kubernetes-prow", botType),
			// Machine user account caught by the login heuristic.
			testComment("k8s-infra-ci-robot", userType),
			// Regular human commenter.
			testComment("bob", userType),
		},
		Reviews: []*octodeckv1.Review{
			octodeckv1.Review_builder{Author: testUser("copilot-pull-request-reviewer", botType)}.Build(),
		},
	}.Build()

	got := extractBotsFromItems([]*octodeckv1.Item{item}, nil, "")
	assert.ElementsMatch(t, []string{"kubernetes-prow", "k8s-infra-ci-robot", "copilot-pull-request-reviewer"}, got)
}

func TestExtractBotsFromItems_NeverIncludesCurrentUser(t *testing.T) {
	item := octodeckv1.Item_builder{
		Author: testUser("TallClair", octodeckv1.UserType_USER_TYPE_USER),
		Comments: []*octodeckv1.Comment{
			testComment("tallclair", userType),
		},
	}.Build()

	// Even if the current user was previously (wrongly) persisted to known bots, they must not be
	// re-discovered as a bot.
	got := extractBotsFromItems([]*octodeckv1.Item{item}, []string{"tallclair"}, "tallclair")
	assert.Empty(t, got)
}
