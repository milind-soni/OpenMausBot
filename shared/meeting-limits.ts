export interface MeetingLimits {
  replies?: { wrapUpAfter: number; hardStop: number };
  tokens?: { wrapUpAt: number; hardStop: number; count: "total" };
  time?: { wrapUpSeconds: number; seconds: number };
  cost?: { wrapUpUsd: number; hardStopUsd: number };
}
export interface MeetingUsage { input?: number; output?: number; cachedInput?: number }
export interface MeetingBudgetState {
  replies?: number; tokens?: number; costUsd?: number; startedAt: number; now?: number;
  turnMilliseconds?: number; turnTokens?: number; turnCostUsd?: number;
}
export interface MeetingBudgetSnapshot {
  wrapUp: boolean; exhausted: boolean; reasons: string[];
  replies?: { used: number; remaining: number; hardStop: number; wrapUpAfter: number };
  tokens?: { used: number; remaining: number; hardStop: number; count: "total"; wrapUpAt: number };
  time?: { remainingSeconds: number; deadline: string; elapsedSeconds: number; wrapUpSeconds: number };
  cost?: { usedUsd: number; remainingUsd: number; hardStopUsd: number; wrapUpUsd: number; basis: string };
}
export const DEFAULT_MEETING_LIMITS = Object.freeze({replies: {wrapUpAfter:16, hardStop:22}});
function fail(message: string): never {throw Object.assign(new Error(message),{status:400});}
function object(value: unknown, name: string, keys: string[]): asserts value is Record<string, unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${name} must be an object`);
  for(const key of Object.keys(value))if(!keys.includes(key))fail(`Unknown ${name} field: ${key}`);
}
const integer=(value: unknown,name: string,min: number,max: number): number =>{
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>max)fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
// A custom object replaces the defaults. Omitted dimensions are disabled.
export function normalizeMeetingLimits(value?: unknown): MeetingLimits {
  if(value===undefined||value===null)return structuredClone(DEFAULT_MEETING_LIMITS);
  object(value,'meetingLimits',['replies','tokens','time','cost']);
  const limits: MeetingLimits={};
  if(value.replies!=null){
    object(value.replies,'replies',['hardStop','wrapUpAfter']);
    const hardStop=integer(value.replies.hardStop,'reply hard stop',1,100000);
    const wrapUpAfter=integer(value.replies.wrapUpAfter??Math.floor(hardStop*0.7),'reply wrap-up',0,hardStop-1);
    limits.replies={wrapUpAfter,hardStop};
  }
  if(value.tokens!=null){
    object(value.tokens,'tokens',['hardStop','wrapUpAt','count']);
    const hardStop=integer(value.tokens.hardStop,'token hard stop',1,1000000000);
    const wrapUpAt=integer(value.tokens.wrapUpAt??Math.floor(hardStop*0.7),'token wrap-up',0,hardStop-1);
    const count=value.tokens.count??'total';
    if(count!=='total')fail('Meeting tokens count all input, cached input and output');
    limits.tokens={wrapUpAt,hardStop,count};
  }
  if(value.time!=null){
    object(value.time,'time',['seconds','wrapUpSeconds']);
    const seconds=integer(value.time.seconds,'meeting duration in seconds',1,604800);
    const wrapUpSeconds=integer(value.time.wrapUpSeconds??Math.floor(seconds*0.7),'time wrap-up in seconds',0,seconds-1);
    limits.time={wrapUpSeconds,seconds};
  }
  if(value.cost!=null){
    object(value.cost,'cost',['hardStopUsd','wrapUpUsd']);
    const hardStopUsd = value.cost.hardStopUsd;
    if(typeof hardStopUsd!=="number")fail('Dollar hard stop must be a number');
    const wrapUpUsd = value.cost.wrapUpUsd ?? Number((hardStopUsd*.7).toPrecision(10));
    if(typeof wrapUpUsd!=="number")fail('Dollar wrap-up must be a number');
    if(!Number.isFinite(hardStopUsd)||hardStopUsd<=0||hardStopUsd>100000)fail('Dollar hard stop must be greater than 0 and at most 100000');
    if(!Number.isFinite(wrapUpUsd)||wrapUpUsd<0||wrapUpUsd>=hardStopUsd)fail('Dollar wrap-up must be nonnegative and below the hard stop');
    limits.cost={hardStopUsd,wrapUpUsd};
  }
  if(!Object.keys(limits).length)fail('Enable at least one meeting limit, or use null for the 16/22 default');
  return limits;
}
export function usageTokens(usage: MeetingUsage | undefined) {
  const n=(x: number | undefined)=>typeof x === "number" && Number.isFinite(x)?Math.max(0,x):0;
  return n(usage?.input)+n(usage?.output);
}
export const WRAP_UP_INSTRUCTION='Wrap up: use the remaining allowance to finish open questions, ongoing work and conclusions. Do not stop immediately or start new topics; bring the exchange to a natural close before the hard stop.';
export function meetingBudgetSnapshot(limits: MeetingLimits,{replies=0,tokens=0,costUsd=0,startedAt,now=Date.now(),turnMilliseconds=0,turnTokens=0,turnCostUsd=0}: MeetingBudgetState): MeetingBudgetSnapshot {
  const elapsed=Math.max(0,now-startedAt);
  const result: MeetingBudgetSnapshot={wrapUp:false,exhausted:false,reasons:[]};
  if(limits.replies){
    const c=limits.replies;
    result.replies={used:replies,remaining:Math.max(0,c.hardStop-replies),hardStop:c.hardStop,wrapUpAfter:c.wrapUpAfter};
    result.wrapUp ||= replies>=c.wrapUpAfter;
    if(replies>=c.hardStop)result.reasons.push('reply');
  }
  if(limits.tokens){
    const c=limits.tokens;
    // Reserve at least three observed turns for finishing when calls are costly.
    const wrapUpAt=Math.min(c.wrapUpAt,Math.max(0,c.hardStop-3*turnTokens));
    result.tokens={used:tokens,remaining:Math.max(0,c.hardStop-tokens),hardStop:c.hardStop,count:c.count,wrapUpAt};
    result.wrapUp ||= tokens>=wrapUpAt;
    if(tokens>=c.hardStop)result.reasons.push('token');
  }
  if(limits.time){
    const c=limits.time,deadline=startedAt+c.seconds*1000;
    const wrapUpAt=Math.min(c.wrapUpSeconds*1000,Math.max(0,c.seconds*1000-3*turnMilliseconds));
    result.time={remainingSeconds:Math.max(0,Math.ceil((deadline-now)/1000)),deadline:new Date(deadline).toISOString(),elapsedSeconds:Math.floor(elapsed/1000),wrapUpSeconds:Math.floor(wrapUpAt/1000)};
    result.wrapUp ||= elapsed>=wrapUpAt;
    if(now>=deadline)result.reasons.push('time');
  }
  if(limits.cost){
    const c=limits.cost,wrapUpUsd=Math.min(c.wrapUpUsd,Math.max(0,c.hardStopUsd-3*turnCostUsd));
    result.cost={usedUsd:costUsd,remainingUsd:Math.max(0,c.hardStopUsd-costUsd),hardStopUsd:c.hardStopUsd,wrapUpUsd,basis:'OpenRouter published token rates; includes cached input and private checks'};
    result.wrapUp ||= costUsd>=wrapUpUsd;
    if(costUsd>=c.hardStopUsd)result.reasons.push('dollar');
  }
  result.exhausted=result.reasons.length>0;
  return result;
}
export function meetingBudgetText(budget: MeetingBudgetSnapshot) {
  const parts=[];
  if(budget.replies)parts.push(`${budget.replies.remaining} of ${budget.replies.hardStop} replies left`);
  if(budget.tokens)parts.push(`${budget.tokens.remaining} of ${budget.tokens.hardStop} tokens left (all input + output, including private checks)`);
  if(budget.time)parts.push(`${budget.time.remainingSeconds} seconds left; deadline ${budget.time.deadline}`);
  if(budget.cost)parts.push(`$${budget.cost.remainingUsd.toFixed(6)} of $${budget.cost.hardStopUsd.toFixed(6)} left at OpenRouter rates`);
  return `Meeting allowance: ${parts.join('; ')}. ${budget.exhausted?`Hard stop reached (${budget.reasons.join(', ')} limit).`:budget.wrapUp?WRAP_UP_INSTRUCTION:'You may finish naturally before the limits.'}`;
}
