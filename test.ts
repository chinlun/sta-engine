import { tool } from 'ai';
import { z } from 'zod';

const t = tool({
    description: "test test",
    parameters: z.object({ foo: z.string() }),
    execute: async (args, options) => {
        return "bar";
    }
});
