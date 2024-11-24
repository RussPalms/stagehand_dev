import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { LLMClient, ChatCompletionOptions } from "./LLMClient";
import { LLMCache } from "../cache/LLMCache";
import { LogLine } from "../types";
import { zodToJsonSchema } from "zod-to-json-schema";
import { validateZodSchema } from "../utils";

export class OpenAIClient implements LLMClient {
  public type: "openai" = "openai";
  private client: OpenAI;
  private cache: LLMCache | undefined;
  public logger: (message: LogLine) => void;
  private enableCaching: boolean;
  private requestId: string;

  constructor(
    logger: (message: LogLine) => void,
    enableCaching = false,
    cache: LLMCache | undefined,
    requestId: string,
  ) {
    this.client = new OpenAI();
    this.logger = logger;
    this.requestId = requestId;
    this.cache = cache;
    this.enableCaching = enableCaching;
  }

  async createChatCompletion(
    options: ChatCompletionOptions,
    retries: number = 3,
  ): Promise<any> {
    const { image: _, ...optionsWithoutImage } = options;

    // O1 models do not support most of the options. So we override them.
    // For schema and tools, we add them as user messages.
    let isToolsOverridedForO1 = false;
    if (options.model === "o1-mini" || options.model === "o1-preview") {
      options.messages = options.messages.map((message) => ({
        ...message,
        role: "user",
      }));
      options.temperature = undefined;
      options.top_p = undefined;
      options.frequency_penalty = undefined;
      options.presence_penalty = undefined;
      options.tool_choice = undefined;
      if (options.tool && options.response_model) {
        throw new Error(
          "Cannot use both tool and response_model for o1 models",
        );
      }

      if (options.tools) {
        isToolsOverridedForO1 = true;
        options.messages.push({
          role: "user",
          content: `You have the following tools available to you:\n${JSON.stringify(
            options.tools,
          )}

          Respond with the following zod schema format to use a method: {
            "name": "<tool_name>",
            "arguments": <tool_args>
          }
          
          Do not include any other text or formattings like \`\`\` in your response. Just the JSON object.`,
        });

        options.tools = undefined;
      }
    }

    this.logger({
      category: "openai",
      message: "creating chat completion",
      level: 1,
      auxiliary: {
        options: {
          value: JSON.stringify(optionsWithoutImage),
          type: "object",
        },
      },
    });
    const cacheOptions = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      image: options.image,
      response_model: options.response_model,
    };

    if (this.enableCaching) {
      const cachedResponse = await this.cache.get(cacheOptions, this.requestId);
      if (cachedResponse) {
        this.logger({
          category: "llm_cache",
          message: "LLM cache hit - returning cached response",
          level: 1,
          auxiliary: {
            requestId: {
              value: this.requestId,
              type: "string",
            },
            cachedResponse: {
              value: JSON.stringify(cachedResponse),
              type: "object",
            },
          },
        });
        return cachedResponse;
      } else {
        this.logger({
          category: "llm_cache",
          message: "LLM cache miss - no cached response found",
          level: 1,
          auxiliary: {
            requestId: {
              value: this.requestId,
              type: "string",
            },
          },
        });
      }
    }

    if (options.image) {
      const screenshotMessage: any = {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${options.image.buffer.toString("base64")}`,
            },
          },
          ...(options.image.description
            ? [{ type: "text", text: options.image.description }]
            : []),
        ],
      };

      options.messages = [...options.messages, screenshotMessage];
    }

    const { image, response_model, ...openAiOptions } = options;

    let responseFormat = undefined;
    if (options.response_model) {
      // For O1 models, we need to add the schema as a user message.
      if (options.model === "o1-mini" || options.model === "o1-preview") {
        try {
          const parsedSchema = JSON.stringify(
            zodToJsonSchema(options.response_model.schema),
          );
          options.messages.push({
            role: "user",
            content: `Respond in this zod schema format:\n${parsedSchema}\n

          Do not include any other text, formating or markdown in your output. Do not include \`\`\` or \`\`\`json in your response. Only the JSON object itself.`,
          });
        } catch (error) {
          this.logger({
            category: "openai",
            message: "Failed to parse response model schema",
            level: 0,
          });

          if (retries > 0) {
            return this.createChatCompletion(options, retries - 1);
          }

          throw error;
        }
      } else {
        responseFormat = zodResponseFormat(
          options.response_model.schema,
          options.response_model.name,
        );
      }
    }

    const response = await this.client.chat.completions.create({
      ...openAiOptions,
      response_format: responseFormat,
    });

    // For O1 models, we need to parse the tool call response manually and add it to the response.
    if (isToolsOverridedForO1) {
      try {
        const parsedContent = JSON.parse(response.choices[0].message.content);

        response.choices[0].message.tool_calls = [
          {
            function: {
              name: parsedContent["name"],
              arguments: JSON.stringify(parsedContent["arguments"]),
            },
            type: "function",
            id: "-1",
          },
        ];
        response.choices[0].message.content = null;
      } catch (error) {
        this.logger({
          category: "openai",
          message: "Failed to parse tool call response",
          level: 0,
          auxiliary: {
            error: {
              value: error.message,
              type: "string",
            },
            content: {
              value: response.choices[0].message.content,
              type: "string",
            },
          },
        });

        if (retries > 0) {
          return this.createChatCompletion(options, retries - 1);
        }

        throw error;
      }
    }

    this.logger({
      category: "openai",
      message: "response",
      level: 1,
      auxiliary: {
        response: {
          value: JSON.stringify(response),
          type: "object",
        },
        requestId: {
          value: this.requestId,
          type: "string",
        },
      },
    });

    if (options.response_model) {
      const extractedData = response.choices[0].message.content;
      const parsedData = JSON.parse(extractedData);

      if (!validateZodSchema(options.response_model.schema, parsedData)) {
        if (retries > 0) {
          return this.createChatCompletion(options, retries - 1);
        }

        throw new Error("Invalid response schema");
      }

      if (this.enableCaching) {
        this.cache.set(
          cacheOptions,
          {
            ...parsedData,
          },
          this.requestId,
        );
      }

      return {
        ...parsedData,
      };
    }

    if (this.enableCaching) {
      this.logger({
        category: "llm_cache",
        message: "caching response",
        level: 1,
        auxiliary: {
          requestId: {
            value: this.requestId,
            type: "string",
          },
          cacheOptions: {
            value: JSON.stringify(cacheOptions),
            type: "object",
          },
          response: {
            value: JSON.stringify(response),
            type: "object",
          },
        },
      });
      this.cache.set(cacheOptions, response, this.requestId);
    }

    return response;
  }
}
