import Anthropic from '@anthropic-ai/sdk';
import type { UnreadMoment } from './types';

export async function generateUnreadCallout(moment: UnreadMoment): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 120,
      system: `You are a snarky but fair code coach reviewing a developer's conversation with Claude Code.
Call out the exact phrase or line in Claude's response that already answered the user's follow-up question.
Be direct and slightly roast them. One short sentence. Start with "I literally said:" or "Already covered:" or "Right above this:" or similar.`,
      messages: [{
        role: 'user',
        content: `Claude's response:\n"${moment.claudeText}"\n\nUser's follow-up:\n"${moment.userFollowUp}"`,
      }],
    });

    return response.content.find(b => b.type === 'text')?.text?.trim() ?? null;
  } catch {
    return null;
  }
}
