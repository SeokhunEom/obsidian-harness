import { z } from 'zod';
import { PolicyError } from './policy';
import { RunGuard } from './budget';
export interface ToolDefinition<I, O> {
  name: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  authorize(input: I): void | Promise<void>;
  execute(input: I, signal?: AbortSignal): Promise<O>;
}
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>();
  register<I, O>(definition: ToolDefinition<I, O>): void {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(definition.name) || this.tools.has(definition.name))
      throw new PolicyError('TOOL_INVALID', '중복되거나 잘못된 도구 이름입니다.');
    if (
      !(definition.input instanceof z.ZodObject) ||
      definition.input._def.unknownKeys !== 'strict'
    )
      throw new PolicyError('SCHEMA_INVALID', '입력 도구 스키마는 strict 객체여야 합니다.');
    if (
      !(definition.output instanceof z.ZodObject) ||
      definition.output._def.unknownKeys !== 'strict'
    )
      throw new PolicyError('SCHEMA_INVALID', '출력 도구 스키마는 strict 객체여야 합니다.');
    this.tools.set(definition.name, definition);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  async invoke(name: string, input: unknown, guard: RunGuard): Promise<unknown> {
    guard.check();
    const tool = this.tools.get(name);
    if (!tool) throw new PolicyError('TOOL_UNKNOWN', '등록되지 않은 도구입니다.');
    const parsed = tool.input.parse(input);
    await tool.authorize(parsed);
    guard.tool();
    const output = await tool.execute(parsed, guard.signal);
    guard.check();
    return tool.output.parse(output);
  }
}
