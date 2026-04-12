import { tool } from 'ai';
import { z } from 'zod';
import { asSchema } from '@ai-sdk/provider-utils';

const testTool = tool({
    description: 'test inputSchema tool',
    inputSchema: z.object({
        storeName: z.string().describe('The name of the shop'),
        summary: z.string().describe('Brief summary of the business requirements gathered')
    }),
    execute: async (args) => {
        return { status: 'OK' };
    }
});

console.log("jsonSchema:", JSON.stringify(asSchema(testTool.inputSchema).jsonSchema, null, 2));
