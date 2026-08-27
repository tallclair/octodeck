import { describe, it, expect } from 'vitest';
import { isNoise, groupComments, type CommentLike } from '../noiseFilter';
import { CommentNoiseType } from '../../api/octodeck/v1/resources_pb';

describe('NoiseFilter', () => {
  describe('CommentNoiseType classification', () => {
    it('correctly classifies comments based on noiseType', () => {
      expect(isNoise({ noiseType: CommentNoiseType.UNSPECIFIED })).toBe(false);
      expect(isNoise({ noiseType: CommentNoiseType.BOT_AUTHOR })).toBe(true);
      expect(isNoise({ noiseType: CommentNoiseType.SLASH_COMMAND })).toBe(true);
      expect(isNoise({})).toBe(false);
    });
  });

  describe('groupComments', () => {
    const createComment = (
      login: string,
      body: string,
      createdAt: string,
      noiseType: CommentNoiseType = CommentNoiseType.UNSPECIFIED
    ): CommentLike & { noiseType: CommentNoiseType; bodyText: string; url: string; createdAt: string } => ({
      author: { login },
      bodyText: body,
      createdAt,
      url: `https://github.com/owner/repo/issues/1#issuecomment-${Date.now()}`,
      noiseType,
    });

    it('passes through human comments', () => {
      const comments = [
        createComment('alice', 'Hello', '2023-01-01T10:00:00Z', CommentNoiseType.UNSPECIFIED),
        createComment('bob', 'World', '2023-01-01T11:00:00Z', CommentNoiseType.UNSPECIFIED),
      ];
      const result = groupComments(comments);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('COMMENT');
      expect(result[1].type).toBe('COMMENT');
    });

    it('collapses consecutive bot comments', () => {
      const comments = [
        createComment('alice', 'Hello', '2023-01-01T10:00:00Z', CommentNoiseType.UNSPECIFIED),
        createComment('k8s-ci-robot', 'CI Running', '2023-01-01T10:05:00Z', CommentNoiseType.BOT_AUTHOR),
        createComment('prow', 'Job started', '2023-01-01T10:06:00Z', CommentNoiseType.BOT_AUTHOR),
        createComment('bob', 'Response', '2023-01-01T12:00:00Z', CommentNoiseType.UNSPECIFIED),
      ];
      
      const result = groupComments(comments);
      expect(result).toHaveLength(3); // User, BotGroup, User
      
      expect(result[0].type).toBe('COMMENT');
      
      const group = result[1];
      expect(group.type).toBe('BOT_SUMMARY');
      if (group.type === 'BOT_SUMMARY') {
        expect(group.count).toBe(2);
        expect(group.authors).toEqual(expect.arrayContaining(['k8s-ci-robot', 'prow']));
        expect(group.timestamp).toBe('2023-01-01T10:06:00Z'); // Latest timestamp
        expect(group.hasFailure).toBe(false);
      }
    });

    it('collapses slash commands as noise', () => {
      const comments = [
        createComment('alice', '/lgtm', '2023-01-01T10:00:00Z', CommentNoiseType.SLASH_COMMAND),
        createComment('bob', '/approve', '2023-01-01T10:05:00Z', CommentNoiseType.SLASH_COMMAND),
      ];
      
      const result = groupComments(comments);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('BOT_SUMMARY');
      if (result[0].type === 'BOT_SUMMARY') {
          expect(result[0].count).toBe(2);
      }
    });

    it('uses backend provided noiseType during comment grouping', () => {
      const comments = [
        createComment('alice', 'Hello', '2023-01-01T10:00:00Z', CommentNoiseType.UNSPECIFIED),
        createComment('alice', 'Automated Bot Log', '2023-01-01T10:05:00Z', CommentNoiseType.BOT_AUTHOR),
        createComment('bob', 'Slash command text', '2023-01-01T10:06:00Z', CommentNoiseType.SLASH_COMMAND),
        createComment('bob', 'Final human comment', '2023-01-01T10:10:00Z', CommentNoiseType.UNSPECIFIED),
      ];

      const result = groupComments(comments);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('COMMENT');
      expect(result[1].type).toBe('BOT_SUMMARY');
      if (result[1].type === 'BOT_SUMMARY') {
        expect(result[1].count).toBe(2);
      }
      expect(result[2].type).toBe('COMMENT');
    });

    it('detects failures in noise', () => {
      const comments = [
        createComment('k8s-ci-robot', 'Build failed', '2023-01-01T10:00:00Z', CommentNoiseType.BOT_AUTHOR),
      ];
      const result = groupComments(comments);
      if (result[0].type === 'BOT_SUMMARY') {
          expect(result[0].hasFailure).toBe(true);
      } else {
          throw new Error('Expected BOT_SUMMARY');
      }
    });

    it('detects failures in grouped noise', () => {
      const comments = [
        createComment('k8s-ci-robot', 'Build started', '2023-01-01T10:00:00Z', CommentNoiseType.BOT_AUTHOR),
        createComment('k8s-ci-robot', 'Build Unsuccessful', '2023-01-01T10:01:00Z', CommentNoiseType.BOT_AUTHOR),
      ];
      const result = groupComments(comments);
      if (result[0].type === 'BOT_SUMMARY') {
          expect(result[0].hasFailure).toBe(true);
      }
    });
  });
});


