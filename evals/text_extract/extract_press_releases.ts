import { EvalFunction } from "../../types/evals";
import { initStagehand } from "../utils";
import { z } from "zod";
import { compareStrings } from "../utils";

export const extract_press_releases: EvalFunction = async ({
  modelName,
  logger,
  useTextExtract,
}) => {
  const { stagehand, initResponse } = await initStagehand({
    modelName,
    logger,
    domSettleTimeoutMs: 3000,
  });

  const { debugUrl, sessionUrl } = initResponse;

  try {
    await stagehand.page.goto("https://www.landerfornyc.com/news", {
      waitUntil: "networkidle",
    });
    // timeout for 5 seconds to allow for the page to load
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const schema = z.object({
      items: z.array(
        z.object({
          title: z.string().describe("The title of the press release"),
          publish_date: z
            .string()
            .describe(
              "The date the press release was published, eg 'Oct 12, 2021'",
            ),
        }),
      ),
    });

    const rawResult = await stagehand.extract({
      instruction:
        "extract the title and corresponding publish date of EACH AND EVERY press releases on this page. DO NOT MISS ANY PRESS RELEASES.",
      schema,
      modelName,
      useTextExtract,
    });

    const { items } = schema.parse(rawResult);

    await stagehand.close();

    const expectedLength = 28;
    const expectedFirstItem = {
      title: "UAW Region 9A Endorses Brad Lander for Mayor",
      publish_date: "Dec 4, 2024",
    };
    const expectedLastItem = {
      title: "An Unassuming Liberal Makes a Rapid Ascent to Power Broker",
      publish_date: "Jan 23, 2014",
    };

    if (items.length <= expectedLength) {
      logger.error({
        message: "Not enough items extracted",
        level: 0,
        auxiliary: {
          expected: {
            value: `> ${expectedLength}`,
            type: "string",
          },
          actual: {
            value: items.length.toString(),
            type: "integer",
          },
        },
      });
      return {
        _success: false,
        error: "Not enough items extracted",
        logs: logger.getLogs(),
        debugUrl,
        sessionUrl,
      };
    }

    const isItemMatch = (
      item: { title: string; publish_date: string },
      expected: { title: string; publish_date: string },
    ) => {
      const titleComparison = compareStrings(item.title, expected.title, 0.9);
      const dateComparison = compareStrings(
        item.publish_date,
        expected.publish_date,
        0.9,
      );
      return titleComparison.meetsThreshold && dateComparison.meetsThreshold;
    };

    const foundFirstItem = items.some((item) =>
      isItemMatch(item, expectedFirstItem),
    );
    const foundLastItem = items.some((item) =>
      isItemMatch(item, expectedLastItem),
    );

    return {
      _success: foundFirstItem && foundLastItem,
      logs: logger.getLogs(),
      debugUrl,
      sessionUrl,
    };
  } catch (error) {
    logger.error({
      message: `Error in extract_press_releases function`,
      level: 0,
      auxiliary: {
        error: {
          value: error.message || JSON.stringify(error),
          type: "string",
        },
        trace: {
          value: error.stack,
          type: "string",
        },
      },
    });
    return {
      _success: false,
      error: "An error occurred during extraction",
      logs: logger.getLogs(),
      debugUrl,
      sessionUrl,
    };
  } finally {
    await stagehand.context.close();
  }
};
