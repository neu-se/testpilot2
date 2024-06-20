import dedent from "dedent";
import { APIFunction, sanitizePackageName } from "./exploreAPI";
import { TestOutcome, TestStatus } from "./report";
import { closeBrackets, commentOut, trimAndCombineDocComment } from "./syntax";
import handlebars from "handlebars";
import fs from "fs";

/**
 * A strategy object for refining a prompt based on the outcome of a test
 * generated from it.
 */
export interface IPromptRefiner {
  /** A human-readable name for identifying this refiner. */
  get name(): string;

  /**
   * Refine the `original` prompt based on the `outcome` of a test generated
   * from it and the given `body`.
   */
  refine(original: Prompt, body: string, outcome: TestOutcome): Prompt[];
}

/**
 * Options for controlling prompt generation.
 */
type PromptOptions = {
  /** Whether to include usage snippets in the prompt. */
  includeSnippets: boolean;
  /** Whether to include the function's doc comment in the prompt. */
  includeDocComment: boolean;
  /** Whether to include the function's body in the prompt. */
  includeFunctionBody: boolean;
  /** Template file used to generate prompts for chat model */
  templateFileName?: string;
  /** Template file used to generate prompts when errors occur */
  retryTemplateFileName?: string;
};

export function defaultPromptOptions(): PromptOptions {
  return {
    includeSnippets: false,
    includeDocComment: false,
    includeFunctionBody: false,
  };
}

/**
 * Structured representation of a prompt we send to the model.
 *
 * In general, our prompts look like this:
 *
 * ```js
 * let mocha = require('mocha');            // -+
 * let assert = require('assert');          //  | Imports
 * let pkg = require('pkg');                // -+
 *
 * // usage #1                              // -+
 * ...                                      //  |
 * // usage #2                              //  | Usage snippets
 * ...                                      // -+
 *
 * // this does...                          // -+
 * // @param foo                            //  |
 * // @returns bar                          //  | Doc comment
 * ...                                      // -+
 *
 * // fn(args)                              //    Signature of the function we're testing
 * // function fn(args) {                   // -+
 * //     ...                               //  | Function body (optional)
 * // }                                     // -+
 *
 * describe('test pkg', function() {        //    Test suite header
 *   it('test fn', function(done) {         //    Test case header
 * ```
 *
 * The structured representation keeps track of these parts and provides methods
 * to assemble them into a textual prompt and complete them into a test case.
 */
export class Prompt {
  private readonly imports: string;
  private readonly signature: string;
  private readonly docComment: string;
  private readonly functionBody: string;
  private readonly suiteHeader: string;
  protected readonly testHeader: string;
  public readonly provenance: PromptProvenance[] = [];

  constructor(
    public readonly fun: APIFunction,
    public readonly usageSnippets: string[],
    public readonly options: PromptOptions
  ) {
    const sanitizedPackageName = sanitizePackageName(fun.packageName);
    this.imports = dedent`
            let mocha = require('mocha');
            let assert = require('assert');
            let ${sanitizedPackageName} = require('${fun.packageName}');\n`;

    this.signature = fun.signature;

    if (options.includeFunctionBody) {
      this.functionBody = fun.descriptor.implementation;
    } else {
      this.functionBody = "";
    }

    this.suiteHeader = `describe('test ${sanitizedPackageName}', function() {\n`;
    this.testHeader = `    it('test ${fun.accessPath}', function(done) {\n`;

    if (options.includeDocComment) {
      this.docComment = trimAndCombineDocComment(
        fun.descriptor.docComment ?? ""
      );
    } else {
      this.docComment = "";
    }
  }

  /**
   * Assemble the usage snippets into a single string.
   */
  private assembleUsageSnippets(): string {
    if (!this.options.includeSnippets) {
      return "";
    } else {
      return this.usageSnippets
        .map((snippet, index) => {
          const lines = snippet.split("\n");
          return `// usage #${index + 1}\n` + lines.join("") + "\n";
        })
        .join("");
    }
  }

  /**
   * Assemble a prompt to send to the model from the structured
   * representation.
   */
  public assemble(): string {
    // return this.embedInTemplate(this.signature, this.functionBody, this.docComment, this.assembleUsageSnippets(),
    const signature = this.signature;
    const functionBody = this.functionBody;
    const docComments = this.docComment;
    const snippets = this.assembleUsageSnippets();
    const headers = this.imports + this.suiteHeader + this.testHeader;
 
    const templateFileName = this.options.templateFileName;
    const template = fs.readFileSync(templateFileName!, "utf8");
    const compiledTemplate = handlebars.compile(template);
    let expandedTemplate = compiledTemplate({ 
      signature: signature.trim(), 
      docComments: docComments ? docComments : "",
      functionBody: functionBody ? `This function is defined as follows:\n\`\`\`\n${functionBody.trim()}\n\`\`\`` : "",
      snippets: snippets ? `You may use the following examples to guide your implementation:\n\`\`\`\n${snippets}\n\`\`\`` : "",
      code: headers });
    while (expandedTemplate.includes('\n\n\n')){ // avoid unnecessary blank lines
      expandedTemplate = expandedTemplate.replace('\n\n\n','\n\n');
    }
    while (expandedTemplate.includes('\`\`\`\n\n')){ // avoid empty lines at the beginning of fenced code blocks
      expandedTemplate = expandedTemplate.replace('\`\`\`\n\n','\`\`\`\n');
    }
    while (expandedTemplate.includes('\n\n\`\`\`')){ // avoid empty lines at the end of fenced code blocks
      expandedTemplate = expandedTemplate.replace('\n\n\`\`\`','\n\`\`\`');
    }
    if (expandedTemplate.includes('Please')){
      expandedTemplate = expandedTemplate.replace('Please', '\nPlease'); // start new paragraph for the instructions
    }
    if (expandedTemplate.includes('This function')){
      expandedTemplate = expandedTemplate.replace('This function', '\nThis function'); // start new paragraph for the function body
    }
    if (expandedTemplate.includes('You may use')){
      expandedTemplate = expandedTemplate.replace('You may use', '\nYou may use'); // start new paragraph for the examples
    }
    return expandedTemplate;
  }

  /**
   * Given a test body suggested by the model, assemble a complete,
   * syntactically correct test.
   */
  public completeTest(
    body: string,
    stubOutHeaders: boolean = true
  ): string | undefined {

    let code = "";

    // add imports if first line of body does not contain "require"
    const line = body.split('\n')[0];
    if (line.indexOf('require') === -1){
      code += this.imports + '\n';
    }  

    // add headers if they are not already in the body
    if (!body.includes("describe(")){
      code = code +
         (stubOutHeaders
           ? // stub out suite header and test header so we don't double-count identical tests
             "describe('test suite', function() {\n" +
             "    it('test case', function(done) {\n"
           : this.suiteHeader + this.testHeader) +
         // add the body, making sure the first line is indented correctly
         body.trim().replace(/^(?=\S)/, " ".repeat(8)) +
         "\n";
    } else { // only add the body if it already includes test/suite headers
      code += body;
    }
    
    // close brackets
    const fixed = closeBrackets(code);

    // beautify closing brackets
    const beautified = fixed?.source.replace(/\}\)\}\)$/, "    })\n})");
    return beautified;
  }

  // public embedInTemplate(signature: string, functionBody: string, docComments: string, snippets: string, body: string): string {
  //   const templateFileName = this.options.templateFileName;
  //   const template = fs.readFileSync(templateFileName!, "utf8");
  //   const compiledTemplate = handlebars.compile(template);
  //   let expandedTemplate = compiledTemplate({ 
  //     signature: signature.trim(), 
  //     docComments: docComments ? docComments : "",
  //     functionBody: functionBody ? `This function is defined as follows:\n\`\`\`\n${functionBody.trim()}\n\`\`\`` : "",
  //     snippets: snippets ? `You may use the following examples to guide your implementation:\n\`\`\`\n${snippets}\n\`\`\`` : "",
  //     code: body });
  //   while (expandedTemplate.includes('\n\n\n')){ // avoid unnecessary blank lines
  //     expandedTemplate = expandedTemplate.replace('\n\n\n','\n\n');
  //   }
  //   while (expandedTemplate.includes('\`\`\`\n\n')){ // avoid empty lines at the beginning of fenced code blocks
  //     expandedTemplate = expandedTemplate.replace('\`\`\`\n\n','\`\`\`\n');
  //   }
  //   while (expandedTemplate.includes('\n\n\`\`\`')){ // avoid empty lines at the end of fenced code blocks
  //     expandedTemplate = expandedTemplate.replace('\n\n\`\`\`','\n\`\`\`');
  //   }
  //   if (expandedTemplate.includes('Please')){
  //     expandedTemplate = expandedTemplate.replace('Please', '\nPlease'); // start new paragraph for the instructions
  //   }
  //   return expandedTemplate;
  // }

  public withProvenance(...provenanceInfos: PromptProvenance[]): Prompt {
    this.provenance.push(...provenanceInfos);
    return this;
  }

  public functionHasDocComment(): boolean {
    return this.fun.descriptor.docComment !== undefined;
  }
}

/**
 * A record of how a prompt was generated, including information about which
 * `originalPrompt` it was generated from, information about the test that gave
 * rise to the prompt refinement, and the name of the refiner.
 */
export type PromptProvenance = {
  originalPrompt: Prompt;
  testId: number;
  refiner: string;
};

/**
 * A prompt refiner that adds usage snippets to the prompt.
 */
export class SnippetIncluder implements IPromptRefiner {
  public get name(): string {
    return "SnippetIncluder";
  }

  public refine(
    original: Prompt,
    completion: string,
    outcome: TestOutcome
  ): Prompt[] {
    if (
      !original.options.includeSnippets &&
      original.usageSnippets.length > 0
    ) {
      return [
        new Prompt(original.fun, original.usageSnippets, {
          ...original.options,
          includeSnippets: true,
        }),
      ];
    }
    return [];
  }
}

/**
 * A prompt refiner that adds a function's doc comments to the prompt.
 */
export class DocCommentIncluder implements IPromptRefiner {
  public get name(): string {
    return "DocCommentIncluder";
  }

  public refine(
    original: Prompt,
    completion: string,
    outcome: TestOutcome
  ): Prompt[] {
    if (
      !original.options.includeDocComment &&
      original.functionHasDocComment()
    ) {
      return [
        new Prompt(original.fun, original.usageSnippets, {
          ...original.options,
          includeDocComment: true,
        }),
      ];
    }
    return [];
  }
}

export class RetryPrompt extends Prompt {
  constructor(
    private prev: Prompt,
    private body: string,
    private readonly err: string
  ) {
    super(prev.fun, prev.usageSnippets, prev.options);
  }

  public assemble() {
    const rawFailingTest = this.prev.completeTest(this.body);
    const templateFileName = this.options.retryTemplateFileName;
    const template = fs.readFileSync(templateFileName!, "utf8");
    const compiledTemplate = handlebars.compile(template);
    const expandedTemplate = compiledTemplate({ test: rawFailingTest, error: this.err });
    return expandedTemplate;
  }
}

/**
 * A prompt refiner that, for a failed test, adds the error message to the
 * prompt and tries again.
 */
export class RetryWithError implements IPromptRefiner {
  public get name(): string {
    return "RetryWithError";
  }

  public refine(
    original: Prompt,
    completion: string,
    outcome: TestOutcome
  ): Prompt[] {
    if (
      !(original instanceof RetryPrompt) &&
      outcome.status === TestStatus.FAILED
    ) {
      return [new RetryPrompt(original, completion, outcome.err.message)];
    }
    return [];
  }
}

/**
 * A prompt refiner that includes the body of the function in the prompt.
 */
export class FunctionBodyIncluder implements IPromptRefiner {
  public get name(): string {
    return "FunctionBodyIncluder";
  }

  public refine(
    original: Prompt,
    completion: string,
    outcome: TestOutcome
  ): Prompt[] {
    if (
      !original.options.includeFunctionBody &&
      original.fun.descriptor.implementation !== ""
    ) {
      return [
        new Prompt(original.fun, original.usageSnippets, {
          ...original.options,
          includeFunctionBody: true,
        }),
      ];
    }
    return [];
  }
}
