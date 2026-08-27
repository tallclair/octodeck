package logic

import (
	"testing"

	"github.com/stretchr/testify/assert"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
	"github.com/tallclair/octodeck/backend/internal/config"
)

func TestIsSlashCommand(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{"Single command", "/lgtm", true},
		{"Command with spaces", "  /lgtm  ", true},
		{"Command with args", "/assign @foo", true},
		{"Command with colon", "/hold: Depends on #140366", true},
		{"Command with description on same line", "/hold Depends on #140366", true},
		{"Multiple commands", "/lgtm\n/approve", true},
		{"Multiple commands with blank lines", "/lgtm\n\n/approve\n/hold", true},
		{"Slash command with reason on next line is human discussion", "/hold\nDepends on #140366", false},
		{"Mixed content starting with command", "/lgtm\nLooks good!", false},
		{
			name: "User report: commands surrounding human discussion",
			body: "/lgtm\n/approve\n\n" +
				"Regarding the release note, I don't have an opinion. " +
				"It would be noise for most users, but technically it is user-facing.\n" +
				"/hold",
			want: false,
		},
		{"File path", "/path/to/file", false},
		{"C++ comment", "// comment in code", false},
		{"Empty", "", false},
		{"Whitespace only", "   ", false},
		{"Multi-line slash command", "\n\n/lgtm\n/approve\n\n", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsSlashCommand(tt.body)
			assert.Equal(t, tt.want, got, "IsSlashCommand(%q) mismatch", tt.body)
		})
	}
}

func TestIsNoise(t *testing.T) {
	knownBots := []string{"k8s-ci-robot"}

	tests := []struct {
		name    string
		comment *octodeckv1.Comment
		want    bool
	}{
		{
			name: "Bot comment (known)",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
				BodyText: config.Ptr("Job passed"),
			}.Build(),
			want: true,
		},
		{
			name: "Bot comment (typename)",
			comment: octodeckv1.Comment_builder{
				Author: octodeckv1.User_builder{
					Login: config.Ptr("some-bot"),
					Type:  config.Ptr(octodeckv1.UserType_USER_TYPE_BOT),
				}.Build(),
				BodyText: config.Ptr("I am a bot"),
			}.Build(),
			want: true,
		},
		{
			name: "Bot comment (suffix)",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("app[bot]")}.Build(),
				BodyText: config.Ptr("Automated message"),
			}.Build(),
			want: true,
		},
		{
			name: "Slash command",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
				BodyText: config.Ptr("/lgtm"),
			}.Build(),
			want: true,
		},
		{
			name: "Regular comment",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
				BodyText: config.Ptr("Looks good to me"),
			}.Build(),
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsNoise(tt.comment, knownBots)
			assert.Equal(t, tt.want, got, "IsNoise mismatch")
		})
	}
}

func TestIsBot(t *testing.T) {
	knownBots := []string{"k8s-ci-robot", "kubernetes-prow"}

	tests := []struct {
		name     string
		login    string
		userType octodeckv1.UserType
		want     bool
	}{
		{"UserType Bot", "random-user", octodeckv1.UserType_USER_TYPE_BOT, true},
		{"Known bot exact match", "k8s-ci-robot", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Known bot with [bot] suffix in login", "kubernetes-prow[bot]", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Known bot uppercase", "KUBERNETES-PROW", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Unknown user with [bot] suffix", "some-new-app[bot]", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Unknown user with [robot] suffix", "custom-ci[robot]", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Bot suffix word -bot", "fejta-bot", octodeckv1.UserType_USER_TYPE_USER, true},
		{"Regular human user", "tallclair", octodeckv1.UserType_USER_TYPE_USER, false},
		{"Empty login", "", octodeckv1.UserType_USER_TYPE_USER, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsBot(tt.login, tt.userType, knownBots)
			assert.Equal(t, tt.want, got, "IsBot(%q, %v) mismatch", tt.login, tt.userType)
		})
	}
}

func TestClassifyCommentNoise(t *testing.T) {
	knownBots := []string{"k8s-ci-robot"}

	tests := []struct {
		name    string
		comment *octodeckv1.Comment
		want    octodeckv1.CommentNoiseType
	}{
		{
			name:    "Nil comment",
			comment: nil,
			want:    octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED,
		},
		{
			name: "Bot comment (known)",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
				BodyText: config.Ptr("Job passed"),
			}.Build(),
			want: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR,
		},
		{
			name: "Bot comment (typename)",
			comment: octodeckv1.Comment_builder{
				Author: octodeckv1.User_builder{
					Login: config.Ptr("some-bot"),
					Type:  config.Ptr(octodeckv1.UserType_USER_TYPE_BOT),
				}.Build(),
				BodyText: config.Ptr("I am a bot"),
			}.Build(),
			want: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR,
		},
		{
			name: "Bot comment (unknown bot with suffix)",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("app[bot]")}.Build(),
				BodyText: config.Ptr("Automated message"),
			}.Build(),
			want: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR,
		},
		{
			name: "Slash command",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
				BodyText: config.Ptr("/lgtm"),
			}.Build(),
			want: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_SLASH_COMMAND,
		},
		{
			name: "Regular comment",
			comment: octodeckv1.Comment_builder{
				Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
				BodyText: config.Ptr("Looks good to me"),
			}.Build(),
			want: octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyCommentNoise(tt.comment, knownBots)
			assert.Equal(t, tt.want, got, "ClassifyCommentNoise mismatch")
		})
	}
}

func TestClassifyComments(t *testing.T) {
	knownBots := []string{"k8s-ci-robot"}

	c1 := octodeckv1.Comment_builder{
		Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
		BodyText: config.Ptr("Hello world"),
	}.Build()

	c2 := octodeckv1.Comment_builder{
		Author:   octodeckv1.User_builder{Login: config.Ptr("user")}.Build(),
		BodyText: config.Ptr("/lgtm"),
	}.Build()

	c3 := octodeckv1.Comment_builder{
		Author:   octodeckv1.User_builder{Login: config.Ptr("k8s-ci-robot")}.Build(),
		BodyText: config.Ptr("Build succeeded"),
	}.Build()

	item := octodeckv1.Item_builder{
		Id:       config.Ptr("item1"),
		Comments: []*octodeckv1.Comment{c1, c2, c3},
	}.Build()

	ClassifyComments(knownBots, item)

	assert.Equal(t, octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED, c1.GetNoiseType())
	assert.Equal(t, octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_SLASH_COMMAND, c2.GetNoiseType())
	assert.Equal(t, octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR, c3.GetNoiseType())
}
