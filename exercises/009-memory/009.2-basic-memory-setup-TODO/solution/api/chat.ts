import { google } from '@ai-sdk/google';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  streamText,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import {
  loadMemories,
  saveMemories,
  type DB,
} from './memory-persistence.ts';

export type MyMessage = UIMessage<unknown, {}>;

const formatMessageHistory = (messages: UIMessage[]) => {
  return messages
    .map((message) => {
      return `${message.role}: ${partsToText(message.parts)}`;
    })
    .join('\n');
};

const partsToText = (parts: UIMessage['parts']) => {
  return parts
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }

      return '';
    })
    .join('');
};

const formatMemory = (memory: DB.MemoryItem) => {
  return [
    `Memory: ${memory.memory}`,
    `Created At: ${memory.createdAt}`,
  ].join('\n');
};

export const POST = async (req: Request): Promise<Response> => {
  const body: { messages: MyMessage[] } = await req.json();
  const { messages } = body;

  const memories = await loadMemories();

  const memoriesText = memories.map(formatMemory).join('\n\n');
  const stream = createUIMessageStream<MyMessage>({
    execute: async ({ writer }) => {
      const result = streamText({
        model: google('gemini-2.0-flash-lite'),
        system: `You are a helpful assistant that can answer questions and help with tasks.

        The date is ${new Date().toISOString().split('T')[0]}.

        You have access to the following memories:

        <memories>
        ${memoriesText}
        </memories>
        `,
        messages: convertToModelMessages(messages),
      });

      writer.merge(result.toUIMessageStream());
    },
    onFinish: async (response) => {
      const allMessages = [...messages, ...response.messages];

      const memoriesResult = await generateObject({
        model: google('gemini-2.0-flash-lite'),
        schema: z.object({
          memories: z.array(z.string()),
        }),
        system: `You are a memory extraction agent. Your task is to analyze the conversation history and extract permanent memories about the user.

        PERMANENT MEMORIES are facts about the user that:
        - Are unlikely to change over time (preferences, traits, characteristics)
        - Will remain relevant for weeks, months, or years
        - Include personal details, preferences, habits, or important information shared
        - Are NOT temporary or situational information

        EXAMPLES OF PERMANENT MEMORIES:
        - "User prefers dark mode interfaces"
        - "User works as a software engineer"
        - "User has a dog named Max"
        - "User is learning TypeScript"
        - "User prefers concise explanations"
        - "User lives in San Francisco"

        EXAMPLES OF WHAT NOT TO MEMORIZE:
        - "User asked about weather today" (temporary)
        - "User is currently debugging code" (situational)
        - "User said hello" (trivial interaction)

        EXISTING MEMORIES:
        ${memoriesText}

        CONVERSATION HISTORY:
        ${formatMessageHistory(allMessages)}

        Extract any new permanent memories from this conversation. Return an array of memory strings that should be added to the user's permanent memory. Each memory should be a concise, factual statement about the user.

        If no new permanent memories are found, return an empty array.`,
        prompt: `
        CONVERSATION HISTORY:
        ${formatMessageHistory(allMessages)}

        EXISTING MEMORIES:
        ${memoriesText}
        `,
      });

      const newMemories = memoriesResult.object.memories;

      console.log('New Memories', newMemories);

      const result = await saveMemories(
        newMemories.map((memory) => ({
          memory,
          createdAt: new Date().toISOString(),
        })),
      );
    },
  });

  return createUIMessageStreamResponse({
    stream,
  });
};
