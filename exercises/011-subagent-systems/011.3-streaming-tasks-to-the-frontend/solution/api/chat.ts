import { google } from '@ai-sdk/google';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamObject,
  streamText,
  type UIMessage,
} from 'ai';
import z from 'zod';
import { schedulerAgent } from './agents/scheduler-agent.ts';
import { songFinderAgent } from './agents/song-finder-agent.ts';
import { studentNotesManagerAgent } from './agents/student-notes-manager.ts';
import { todosAgent } from './agents/todos-agent.ts';

export type MyMessage = UIMessage<
  unknown,
  {
    task: {
      id: string;
      subagent: string;
      task: string;
      // The diary entry
      output: string;
    };
  }
>;

const subagents = {
  'todos-agent': todosAgent,
  'student-notes-manager': studentNotesManagerAgent,
  'song-finder-agent': songFinderAgent,
  'scheduler-agent': schedulerAgent,
};

const formatMessageHistory = (messages: MyMessage[]) => {
  return messages
    .map((message) => {
      return [
        message.role === 'user' ? '## User' : '## Assistant',
        message.parts
          .map((part) => {
            if (part.type === 'text') {
              return part.text;
            }

            return '';
          })
          .join('\n'),
      ].join('\n');
    })
    .join('\n');
};

export const POST = async (req: Request): Promise<Response> => {
  const body: { messages: MyMessage[] } = await req.json();
  const { messages } = body;

  const stream = createUIMessageStream<MyMessage>({
    execute: async ({ writer }) => {
      const formattedMessages = formatMessageHistory(messages);

      const tasksResult = streamObject({
        model: google('gemini-2.0-flash'),
        system: `
            You are a helpful assistant that manages a multi-agent system.
            You will be given a conversation history and the user's initial prompt.
            You will also be given a plan to follow.

            The current date is ${new Date().toISOString()}.

            You must follow the plan exactly, and generate the _next_ step only.

            If the plan is complete, return an empty list of tasks.

            You have access to four subagents:

            - todos-agent: This agent manages a list of todos.
            - student-notes-manager: This agent manages a list of student notes.
            - song-finder-agent: This agent finds songs using the web.
            - scheduler-agent: This agent manages a calendar.

            You will return a list of tasks to delegate to the subagents.
            These tasks will be executed in parallel.

            Subagents can handle complicated tasks, so don't be afraid to delegate large tasks to them.

            This means that inter-dependent tasks (like finding X and using X to create Y) should be split into two tasks.

            Think step-by-step - first decide what tasks need to be performed,
            then decide which subagent to use for each task.
          `,
        prompt: `
            Initial prompt:
            
            ${formattedMessages}
          `,
        schema: z.object({
          tasks: z.array(
            z.object({
              subagent: z
                .enum([
                  'todos-agent',
                  'student-notes-manager',
                  'song-finder-agent',
                  'scheduler-agent',
                ])
                .describe('The subagent to use'),
              task: z
                .string()
                .describe(
                  'A detailed description of the task to perform',
                ),
            }),
          ),
        }),
      });

      const indexToIdMap = new Map<number, string>();

      for await (const chunk of tasksResult.partialObjectStream) {
        const tasks = chunk.tasks ?? [];

        tasks.forEach((task, index) => {
          if (!indexToIdMap.has(index)) {
            indexToIdMap.set(index, crypto.randomUUID());
          }

          const id = indexToIdMap.get(index)!;

          writer.write({
            type: 'data-task',
            id,
            data: {
              id,
              subagent: task?.subagent ?? '',
              task: task?.task ?? '',
              output: '',
            },
          });
        });
      }

      const tasks = (await tasksResult.object).tasks;

      console.dir(tasks);
    },
    onError(error) {
      console.error(error);
      return 'An error occurred while finding the song.';
    },
  });

  return createUIMessageStreamResponse({
    stream,
  });
};
