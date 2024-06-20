import { ICompletionModel } from "./completionModel";
import { APIFunction } from "./exploreAPI";
import {
  IPromptRefiner,
  Prompt,
  RetryWithError,
  SnippetIncluder,
  DocCommentIncluder,
  FunctionBodyIncluder,
  defaultPromptOptions,
} from "./promptCrafting";
import { ITestInfo, TestOutcome, TestStatus } from "./report";
import { SnippetMap } from "./snippetHelper";
import { ITestResultCollector } from "./testResultCollector";
import { TestValidator } from "./testValidator";
import * as fs from "fs";

/**
 * Context class collecting various bits of information needed for test
 * generation.
 */
export class TestGenerator {
  private refiners: IPromptRefiner[] = [
    new SnippetIncluder(),
    new RetryWithError(),
    new DocCommentIncluder(),
    new FunctionBodyIncluder(),
  ];

  constructor(
    private temperatures: number[],
    private snippetMap: SnippetMap,
    private model: ICompletionModel,
    private templateFileName: string,
    private retryTemplateFileName: string,
    private validator: TestValidator,
    private collector: ITestResultCollector
  ) {}

  /**
   * Generate tests for a given function and validate them.
   */
  async generateAndValidateTests(fun: APIFunction) {
    for (const temperature of this.temperatures) {
      let generatedPassingTests = false;
      const generatedPrompts = new Map<string, Prompt>();
      const snippets = this.snippetMap(fun.functionName) ?? [];
      const promptOptions = {
        ...defaultPromptOptions(),
        templateFileName: this.templateFileName,
        retryTemplateFileName: this.retryTemplateFileName,
      };
      const worklist = [new Prompt(fun, snippets, promptOptions)];
      while (worklist.length > 0) {
        const prompt = worklist.pop()!;

        // check whether we've generated this prompt before; if so, record that
        // fact by updating provenance info and skip it
        const assembledPrompt = prompt.assemble();
        const previousPrompt = generatedPrompts.get(assembledPrompt);
        if (previousPrompt) {
          previousPrompt.withProvenance(...prompt.provenance);
          continue;
        }
        generatedPrompts.set(assembledPrompt, prompt);

        const rawCompletions = await this.model.completions(
          assembledPrompt,
          temperature
        );
        let completions = new Set<string>();
        for (const rawCompletion of rawCompletions) {
          const tests = extractTestFromRawCompletion(rawCompletion);
          if (tests.size > 0) {
            for (const test of tests) {
              const testInfo = this.validateCompletion(
                prompt,
                test,
                temperature
              );
              if (testInfo.outcome.status === TestStatus.PASSED) {
                generatedPassingTests = true;
              }
              this.refinePrompts(prompt, test, testInfo, worklist);
              if (generatedPassingTests) break;
            }
          }
        }
        this.collector.recordPromptInfo(prompt, temperature, completions);
      }
    }
  }

  /**
   * Build a test for the given prompt and completion, validate it, and return
   * a test info object.
   */
  public validateCompletion(
    prompt: Prompt,
    completion: string,
    temperature: number
  ) {
    let testSource = prompt.completeTest(completion);
    const testInfo = this.collector.recordTestInfo(
      testSource ?? completion,
      prompt,
      prompt.fun.accessPath
    );
    if (testInfo.prompts.length > 1) {
      // we have already validated this test
      return testInfo;
    }

    let outcome;
    if (completion === "") {
      outcome = TestOutcome.FAILED({ message: "Empty test" });
    } else if (testSource) {
      outcome = this.validator.validateTest(
        testInfo.testName,
        testInfo.testSource
      );
    } else {
      outcome = TestOutcome.FAILED({ message: "Invalid syntax" });
    }
    this.collector.recordTestResult(testInfo, temperature, outcome);
    return testInfo;
  }

  /**
   * Refine the prompt based on the test outcome, and add the refined prompts
   * to the worklist.
   */
  private refinePrompts(
    prompt: Prompt,
    completion: string,
    testInfo: ITestInfo,
    worklist: Prompt[]
  ) {
    for (const refiner of this.refiners) {
      for (const refinedPrompt of refiner.refine(
        prompt,
        completion,
        testInfo.outcome
      )) {
        const provenance = {
          originalPrompt: prompt,
          testId: testInfo.id,
          refiner: refiner.name,
        };
        worklist.push(refinedPrompt.withProvenance(provenance));
      }
    }
  }
}

function extractTestFromRawCompletion(rawCompletion: string): Set<string> {
  const regExp = /```[^\n\r]*\n((?:.(?!```))*)\n```/gs;
  let match;
  while ((match = regExp.exec(rawCompletion)) !== null) {
    const code = match[1];
    const set = new Set<string>();
    if (code.split("it(").length === 2) {
      set.add(code);
      return set;
    } else {
      // we received a suite with more than one test, turn this into multiple suites each containing one test
      const indexOfSuite = code.indexOf("describe(");
      const indexOfFirstTest = code.indexOf("it(");
      let testIndex = indexOfFirstTest;
      while (code.indexOf("it(", testIndex + 1) !== -1) {
        // while there is another test
        const nextTestIndex = code.indexOf("it(", testIndex + 1);
        const test = code.substring(testIndex, nextTestIndex);
        set.add(test);
        testIndex = nextTestIndex;
      }
      // add the last test
      const lastTest = code.substring(testIndex);
      set.add(lastTest);
      const preSuite = code.substring(0, indexOfSuite);
      const suiteHeader = code.substring(indexOfSuite, indexOfFirstTest);
      const result = new Set(
        [...set].map((test) => {
          return preSuite + suiteHeader + test;
        })
      );
      return result;
    }
  }
  // if we're unable to extract something, return a set containing the raw completion
  // even though it's unlikely to validate
  const set = new Set<string>();
  set.add(rawCompletion);
  return set;
}
