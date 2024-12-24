import { z } from "zod";
import { EvalFunction } from "../../types/evals";
import { Stagehand } from "../../lib";
import { InitResult } from "../../types/stagehand";
import { LogLine } from "../../types/log";
import { loadMind2WebDataset } from "../datasets/mind2web";
import { validateUrlMatch } from "../utils/url_validation";

// Define types for Mind2Web evaluation steps
interface EvaluationStep {
  content: {
    key: string;
    netloc: string | null;
    path: string | null;
    reference_answer: string;
    url: string;
  };
  match_function_name: string;
  method: string | null;
}

// Used in loadMind2WebDataset return type and evaluation loop
export interface TestCase {
  task: string;
  evaluation: EvaluationStep[];
}

interface CategoryScores {
  act: {
    success: number;
    total: number;
    percentage: number;
  };
  extract: {
    success: number;
    total: number;
    percentage: number;
  };
  observe: {
    success: number;
    total: number;
    percentage: number;
  };
}

export const mind2web: EvalFunction = async ({ modelName, logger }) => {
  const logs: LogLine[] = [];
  let currentStagehand: Stagehand | undefined;
  let currentInitResult: InitResult | undefined;

  // Initialize scores
  const scores: CategoryScores = {
    act: { success: 0, total: 0, percentage: 0 },
    extract: { success: 0, total: 0, percentage: 0 },
    observe: { success: 0, total: 0, percentage: 0 },
  };

  try {
    // Load dataset and take first 5 test cases for initial testing
    const allTestCases = await loadMind2WebDataset();
    const testCases = allTestCases.slice(0, 5);

    // Initialize Stagehand
    currentStagehand = new Stagehand({
      env: "LOCAL",
      modelName,
      logger: (message: LogLine) => logger.log(message),
      headless: true,
      verbose: 1,
      enableCaching: true,
    });

    currentInitResult = await currentStagehand.init();

    for (const [index, testCase] of testCases.entries()) {
      logs.push({
        message: `Processing test case ${index + 1}/${testCases.length}: ${testCase.task}`,
        level: 1,
      });

      try {
        // Initialize state for tracking progress and handling retries
        const currentState = {
          progress: [] as string[],
          retryCount: 0,
          maxRetries: 3,
          waitBetweenRetries: 5000, // 5 seconds
        };

        // Process each evaluation step sequentially
        for (const [stepIndex, step] of testCase.evaluation.entries()) {
          // Handle potential security blocks and rate limits
          try {
            await currentStagehand.page.waitForLoadState("domcontentloaded");

            // Check for common block indicators
            const isBlocked = await currentStagehand.page.evaluate(() => {
              const blockTexts = ['blocked', 'access denied', 'security check', 'cloudflare'];
              const pageText = document.body.innerText.toLowerCase();
              return blockTexts.some(text => pageText.includes(text));
            });

            if (isBlocked) {
              if (currentState.retryCount < currentState.maxRetries) {
                currentState.retryCount++;
                logger.log({
                  message: `Detected security block, waiting ${currentState.waitBetweenRetries}ms before retry ${currentState.retryCount}/${currentState.maxRetries}`,
                  level: 1,
                });
                await new Promise(resolve => setTimeout(resolve, currentState.waitBetweenRetries));
                await currentStagehand.page.reload();
                continue;
              } else {
                logger.log({
                  message: `Max retries (${currentState.maxRetries}) reached for blocked page, skipping step`,
                  level: 1,
                });
                scores.act.total++;
                scores.extract.total++;
                scores.observe.total++;
                continue;
              }
            }
            currentState.retryCount = 0;
          } catch (error) {
            logger.log({
              message: `Error during page load: ${error.message}`,
              level: 1,
            });
            if (currentState.retryCount < currentState.maxRetries) {
              currentState.retryCount++;
              continue;
            }
            scores.act.total++;
            scores.extract.total++;
            scores.observe.total++;
            continue;
          }

          // Validate URL match
          const urlMatches = validateUrlMatch(
            step.content.url,
            step.content.reference_answer,
          );
          if (!urlMatches) {
            logger.log({
              message: `URL validation failed for ${step.content.url}`,
              level: 2,
            });
            continue;
          }

          // Navigate to URL if different from current
          if (step.content.url !== currentState.progress[currentState.progress.length - 1]) {
            await currentStagehand.page.goto(step.content.url, {
              waitUntil: "networkidle",
            });
            currentState.progress.push(step.content.url);
            await currentStagehand.page.waitForLoadState("domcontentloaded");
          }

          // Create step-specific schema based on Mind2Web task structure
          const schema = z.object({
            currentUrl: z.string().describe("Current URL of the page"),
            elementDetails: z.object({
              found: z.boolean().describe("Whether the target element was found"),
              text: z.string().describe("Text content of the found element"),
              type: z.string().describe("Type of element (link, button, input, etc.)"),
            }).describe("Details about the target element"),
            nextAction: z.string().describe("Next action needed to complete the task"),
          });

          // Build context from previous steps
          const stepContext = currentState.progress.join(" -> ");

          // Perform action with specific instruction and context
          try {
            const actResult = await currentStagehand.act({
              action: `For task "${testCase.task}":
1. Find element containing "${step.content.reference_answer}"
2. Previous steps completed: ${stepContext}
3. Current URL: ${step.content.url}
4. Target pattern: ${step.content.reference_answer}`
            });

            if (actResult.success) {
              scores.act.success++;
              currentState.progress.push(`Found and interacted with ${step.content.reference_answer}`);
            }
            scores.act.total++;
          } catch (error) {
            logger.log({
              message: `Error during action: ${error.message}`,
              level: 1,
            });
            scores.act.total++;
          }

          // Extract information with context from previous steps
          try {
            const extractResult = await currentStagehand.extract({
              instruction: `For task "${testCase.task}":
1. Extract information about element containing "${step.content.reference_answer}"
2. Previous steps completed: ${stepContext}
3. Target pattern: ${step.content.reference_answer}`,
              schema,
            });

            // Validate extraction against reference and element properties
            const extractSuccess =
              extractResult.elementDetails.found &&
              (extractResult.elementDetails.text.toLowerCase().includes(step.content.reference_answer.toLowerCase()) ||
               extractResult.currentUrl.includes(step.content.reference_answer));

            if (extractSuccess) {
              scores.extract.success++;
            }
            scores.extract.total++;
          } catch (error) {
            logger.log({
              message: `Error during extraction: ${error.message}`,
              level: 1,
            });
            scores.extract.total++;
          }

          // Observe page state with context from previous steps
          try {
            const observeResults = await currentStagehand.observe();
            const observeSuccess = observeResults.some(result =>
              result.description.toLowerCase().includes(step.content.reference_answer.toLowerCase()) ||
              (result.selector && result.selector.toLowerCase().includes(step.content.reference_answer.toLowerCase()))
            );

            if (observeSuccess) {
              scores.observe.success++;
            }
            scores.observe.total++;
          } catch (error) {
            logger.log({
              message: `Error during observation: ${error.message}`,
              level: 1,
            });
            scores.observe.total++;
          }

          // Log detailed progress
          const updateScores = {
            act: (scores.act.success / scores.act.total) * 100,
            extract: (scores.extract.success / scores.extract.total) * 100,
            observe: (scores.observe.success / scores.observe.total) * 100,
          };

          logger.log({
            message: `Step ${stepIndex + 1}/${testCase.evaluation.length} - Act: ${updateScores.act.toFixed(1)}%, Extract: ${updateScores.extract.toFixed(1)}%, Observe: ${updateScores.observe.toFixed(1)}%`,
            level: 1,
            auxiliary: {
              value: {
                value: JSON.stringify({
                  task: testCase.task,
                  step: stepIndex + 1,
                  url: step.content.url,
                  scores: updateScores,
                  progress: currentState.progress,
                }),
                type: "object",
              },
            },
          });
        }

    // Calculate final percentages
    const finalScores = {
      act: (scores.act.success / scores.act.total) * 100,
      extract: (scores.extract.success / scores.extract.total) * 100,
      observe: (scores.observe.success / scores.observe.total) * 100,
    };

    // Check if all thresholds are met
    const success =
      finalScores.act >= 80 &&
      finalScores.extract >= 80 &&
      finalScores.observe >= 80;

    return {
      _success: success,
      logs,
      debugUrl: currentInitResult?.debugUrl || "",
      sessionUrl: currentInitResult?.sessionUrl || "",
      scores: finalScores,
    };
  } catch (error) {
    return {
      _success: false,
      logs,
      debugUrl: currentInitResult?.debugUrl || "",
      sessionUrl: currentInitResult?.sessionUrl || "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (currentStagehand) {
      await currentStagehand.close();
    }
  }
};
