import { CommentNoiseType } from '../api/octodeck/v1/resources_pb';

export interface CommentLike {
  bodyText?: string;
  author?: {
    login?: string;
    avatarUrl?: string;
    __typename?: string;
  };
  noiseType?: CommentNoiseType;
}

export const isNoise = (comment: CommentLike): boolean => {
  return comment.noiseType !== undefined && comment.noiseType !== CommentNoiseType.UNSPECIFIED;
};

export interface BotSummaryGroup {
  type: 'BOT_SUMMARY';
  count: number;
  hasFailure: boolean;
  timestamp: string;
  authors: string[];
  comments: {
    bodyText: string;
    author: {
      login: string;
      avatarUrl?: string;
    };
    url?: string;
    createdAt?: string;
    noiseType?: CommentNoiseType;
  }[];
}

export interface CommentItem {
  type: 'COMMENT';
  data: {
    bodyText: string;
    author: {
      login: string;
      avatarUrl: string;
    };
    url?: string;
    createdAt?: string;
    noiseType?: CommentNoiseType;
  };
  timestamp: string;
}

export type TimelineItem = CommentItem | BotSummaryGroup;

export interface GroupableComment {
  bodyText?: string;
  createdAt?: string;
  author?: {
    login?: string;
    avatarUrl?: string;
    __typename?: string;
  };
  noiseType?: CommentNoiseType;
}

export const isFailureText = (text: string): boolean => {
  if (!/(fail|error|unsuccessful)/i.test(text)) {
    return false;
  }
  if (/(?:no|0|zero|without)\s+(?:errors?|failures?)/i.test(text) && !/(?:[1-9]\d*)\s+(?:errors?|failures?)/i.test(text)) {
    return false;
  }
  return true;
};

export const groupComments = (comments: GroupableComment[]): TimelineItem[] => {
  const sortedComments = [...comments].sort((a, b) =>
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
  );

  return sortedComments.reduce((acc: TimelineItem[], comment) => {
    const bodyText = comment.bodyText || '';
    const login = comment.author?.login || '';
    const avatarUrl = comment.author?.avatarUrl || '';
    const createdAt = comment.createdAt || '';
    const noiseType = comment.noiseType;

    if (isNoise(comment)) {
      const lastItem = acc[acc.length - 1];
      const hasFailure = isFailureText(bodyText);

      const botCommentObj = {
        bodyText,
        author: { login, avatarUrl },
        createdAt,
        noiseType,
      };

      if (lastItem && lastItem.type === 'BOT_SUMMARY') {
        lastItem.count++;
        if (hasFailure) lastItem.hasFailure = true;
        lastItem.timestamp = createdAt;
        if (login && !lastItem.authors.includes(login)) {
          lastItem.authors.push(login);
        }
        lastItem.comments.push(botCommentObj);
      } else {
        acc.push({
          type: 'BOT_SUMMARY',
          count: 1,
          hasFailure,
          timestamp: createdAt,
          authors: login ? [login] : [],
          comments: [botCommentObj],
        });
      }
    } else {
      acc.push({
        type: 'COMMENT',
        data: {
          bodyText,
          author: { login, avatarUrl },
          createdAt,
          noiseType,
        },
        timestamp: createdAt,
      });
    }
    return acc;
  }, []);
};
