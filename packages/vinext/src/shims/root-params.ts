import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

export type RootParams = Record<string, string | string[] | undefined>;

export type RootParamsState = {
  rootParams: RootParams | null;
};

const _FALLBACK_KEY = Symbol.for("vinext.rootParams.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<RootParamsState>("vinext.rootParams.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  rootParams: null,
} satisfies RootParamsState) as RootParamsState;

function getState(): RootParamsState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

export function pickRootParams(
  params: RootParams,
  rootParamNames: readonly string[] | null | undefined,
): RootParams {
  const picked: RootParams = {};
  for (const name of rootParamNames ?? []) {
    picked[name] = params[name];
  }
  return picked;
}

export function setRootParams(params: RootParams | null): void {
  getState().rootParams = params;
}

export function getRootParam(name: string): Promise<string | string[] | undefined> {
  return Promise.resolve(getState().rootParams?.[name]);
}

export function runWithRootParamsScope<T>(params: RootParams, fn: () => Promise<T>): Promise<T>;
export function runWithRootParamsScope<T>(
  params: RootParams,
  fn: () => T | Promise<T>,
): T | Promise<T>;
export function runWithRootParamsScope<T>(
  params: RootParams,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((ctx) => {
      ctx.rootParams = params;
    }, fn);
  } else {
    return _als.run({ rootParams: params }, fn);
  }
}
