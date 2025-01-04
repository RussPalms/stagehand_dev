import type {
  BrowserContext as PlaywrightContext,
  Page as PlaywrightPage,
} from "@playwright/test";
import { Stagehand } from "./index";
import { StagehandPage } from "./StagehandPage";
import { LLMClient } from "./llm/LLMClient";

export class StagehandContext {
  private readonly stagehand: Stagehand;
  private readonly intContext: PlaywrightContext;

  private constructor(context: PlaywrightContext, stagehand: Stagehand) {
    this.intContext = context;
    this.stagehand = stagehand;
  }

  static async init(
    context: PlaywrightContext,
    stagehand: Stagehand,
  ): Promise<StagehandContext> {
    const proxyContext = new Proxy(context, {
      get: (target, prop) => {
        return target[prop as keyof PlaywrightContext];
      },
    });
    const instance = new StagehandContext(proxyContext, stagehand);
    return instance;
  }

  public get context(): PlaywrightContext {
    return this.intContext;
  }
}
