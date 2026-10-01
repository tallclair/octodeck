package logic

import (
	"regexp"
	"strings"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

var (
	botSuffixRegex = regexp.MustCompile(`(?i)\[(?:bot|robot)\]$`)
	botWordRegex   = regexp.MustCompile(`(?i)(?:\[bot\]|\[robot\]|-bot|_bot|-robot|_robot|\bbot\b|\brobot\b)`)
	slashCmdRegex  = regexp.MustCompile(`(?i)^/[a-z0-9_-]+(?:\s|:|$)`)
)

// IsBot checks if a user is a bot based on their login, typename, or known bots list.
func IsBot(login string, userType octodeckv1.UserType, knownBots []string) bool {
	if userType == octodeckv1.UserType_USER_TYPE_BOT {
		return true
	}
	trimmed := strings.TrimSpace(login)
	if trimmed == "" {
		return false
	}
	if botSuffixRegex.MatchString(trimmed) {
		return true
	}
	clean := strings.ToLower(botSuffixRegex.ReplaceAllString(trimmed, ""))
	for _, b := range knownBots {
		cleanB := strings.ToLower(botSuffixRegex.ReplaceAllString(strings.TrimSpace(b), ""))
		if clean == cleanB {
			return true
		}
	}
	return botWordRegex.MatchString(trimmed)
}

// IsSlashCommand checks if the comment consists solely of slash commands.
func IsSlashCommand(body string) bool {
	lines := strings.Split(body, "\n")
	hasCommand := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		if !slashCmdRegex.MatchString(trimmed) {
			return false
		}
		hasCommand = true
	}
	return hasCommand
}

// ClassifyCommentNoise evaluates a comment and returns its CommentNoiseType.
func ClassifyCommentNoise(comment *octodeckv1.Comment, knownBots []string) octodeckv1.CommentNoiseType {
	if comment == nil {
		return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
	}
	if IsBot(comment.GetAuthor().GetLogin(), comment.GetAuthor().GetType(), knownBots) {
		return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_BOT_AUTHOR
	}
	if IsSlashCommand(comment.GetBodyText()) {
		return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_SLASH_COMMAND
	}
	return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
}

// ClassifyCommentNoiseForUser evaluates a comment for a specific user and returns its CommentNoiseType.
// Comments authored by another user that explicitly @mention currentUser are never classified as noise.
func ClassifyCommentNoiseForUser(
	comment *octodeckv1.Comment,
	knownBots []string,
	currentUser string,
) octodeckv1.CommentNoiseType {
	if comment == nil {
		return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
	}
	author := comment.GetAuthor().GetLogin()
	if !isSameUser(author, currentUser) && ContainsMention(comment.GetBodyText(), currentUser) {
		return octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
	}
	return ClassifyCommentNoise(comment, knownBots)
}

// ClassifyComments populates the NoiseType on all comments in the given items.
func ClassifyComments(knownBots []string, items ...*octodeckv1.Item) {
	ClassifyCommentsForUser(knownBots, "", items...)
}

// ClassifyCommentsForUser populates the NoiseType on all comments in the given items,
// treating comments from other users that explicitly @mention currentUser as non-noise.
func ClassifyCommentsForUser(knownBots []string, currentUser string, items ...*octodeckv1.Item) {
	for _, item := range items {
		if item == nil {
			continue
		}
		for _, comment := range item.GetComments() {
			if comment == nil {
				continue
			}
			comment.SetNoiseType(ClassifyCommentNoiseForUser(comment, knownBots, currentUser))
		}
	}
}

// IsNoise determines if a comment is noise (bot comment or slash command).
func IsNoise(comment *octodeckv1.Comment, knownBots []string) bool {
	return ClassifyCommentNoise(comment, knownBots) != octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
}

// IsNoiseForUser determines if a comment is noise relative to currentUser.
func IsNoiseForUser(comment *octodeckv1.Comment, knownBots []string, currentUser string) bool {
	return ClassifyCommentNoiseForUser(comment, knownBots, currentUser) !=
		octodeckv1.CommentNoiseType_COMMENT_NOISE_TYPE_UNSPECIFIED
}
