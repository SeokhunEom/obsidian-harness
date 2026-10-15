import type { Run, RunBudget } from '../contracts';
import { PolicyError } from './policy';
export class RunGuard {
  private startedAt = Date.now();
  constructor(
    public readonly run: Run,
    public readonly budget: RunBudget,
    public readonly signal?: AbortSignal,
  ) {
    if (Object.values(budget).some((value) => !Number.isFinite(value) || value <= 0))
      throw new PolicyError('BUDGET_INVALID', '실행 한도는 유한한 양수여야 합니다.');
  }
  check(): void {
    if (this.signal?.aborted || this.run.state === 'CANCELED')
      throw new PolicyError('CANCELED', '실행이 중단되었습니다.');
    if (Date.now() - this.startedAt >= this.budget.activeTimeoutMs)
      throw new PolicyError('RUN_TIMEOUT', '활성 실행 시간 한도를 초과했습니다.');
  }
  model(inputTokens: number): void {
    this.check();
    if (!Number.isFinite(inputTokens) || inputTokens < 0)
      throw new PolicyError('TOKEN_BUDGET', '잘못된 토큰 추정값입니다.');
    if (this.run.modelCalls >= this.budget.maxModelCalls)
      throw new PolicyError('MODEL_BUDGET', '모델 호출 한도를 초과했습니다.');
    if (
      this.run.inputTokens + inputTokens > this.budget.maxInputTokens ||
      this.run.outputTokens >= this.budget.maxOutputTokens
    )
      throw new PolicyError('TOKEN_BUDGET', '토큰 한도를 초과했습니다.');
    this.run.modelCalls++;
    this.run.inputTokens += inputTokens;
  }
  output(tokens: number): void {
    this.check();
    if (!Number.isFinite(tokens) || tokens < 0)
      throw new PolicyError('TOKEN_BUDGET', '잘못된 출력 토큰 값입니다.');
    this.run.outputTokens += tokens;
    if (this.run.outputTokens > this.budget.maxOutputTokens)
      throw new PolicyError('TOKEN_BUDGET', '출력 토큰 한도를 초과했습니다.');
  }
  tool(): void {
    this.check();
    if (this.run.toolCalls >= this.budget.maxToolCalls)
      throw new PolicyError('TOOL_BUDGET', '도구 호출 한도를 초과했습니다.');
    this.run.toolCalls++;
  }
  get requestTimeoutMs(): number {
    return Math.max(
      1,
      Math.min(
        this.budget.requestTimeoutMs,
        this.budget.activeTimeoutMs - (Date.now() - this.startedAt),
      ),
    );
  }
}
