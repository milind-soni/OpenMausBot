import { isAbsolute } from "node:path";

import type { WorkItemSnapshot } from "./snapshot.ts";

export type ReadinessBlocker = "goal" | "repository" | "acceptance" | "blocking_ambiguity";

export interface ClarificationQuestion {
  id: string;
  title: string;
  question: string;
  recommendedAnswer: string;
  blocker: ReadinessBlocker;
}

export interface DefinitionReadiness {
  ready: boolean;
  blockers: ReadinessBlocker[];
  frontier: ClarificationQuestion[];
}

export function evaluateDefinitionReadiness(
  snapshot: WorkItemSnapshot,
  configuredRepositories: readonly string[],
): DefinitionReadiness {
  const missingGoal = !snapshot.goal || !snapshot.goalConfirmed;
  const missingRepository =
    !snapshot.repository ||
    !isAbsolute(snapshot.repository) ||
    !configuredRepositories.includes(snapshot.repository);
  const missingAcceptance = snapshot.acceptanceConditions.length === 0;
  const blockers: ReadinessBlocker[] = [];
  const candidates: ClarificationQuestion[] = [];

  if (missingGoal) {
    blockers.push("goal");
    candidates.push({
      id: "goal",
      title: "确认目标",
      question: "这项工作必须产生什么明确的业务或用户结果？",
      recommendedAnswer: snapshot.goal
        ? `确认当前目标：“${snapshot.goal}”，或给出修订后的单一目标。`
        : "用一句可验收的话描述目标，并明确确认它。",
      blocker: "goal",
    });
  }
  if (missingRepository) {
    blockers.push("repository");
    candidates.push({
      id: "repository",
      title: "绑定仓库",
      question: "该任务应在哪个已配置的非生产 Git 仓库中执行？",
      recommendedAnswer: "选择项目 Manifest 允许列表中的绝对仓库路径。",
      blocker: "repository",
    });
  }

  // Observable acceptance depends on a settled goal, so it is not on the
  // current frontier until the goal prerequisite is resolved.
  if (missingAcceptance) {
    blockers.push("acceptance");
    if (!missingGoal) {
      candidates.push({
        id: "acceptance",
        title: "补充验收证据",
        question: "用什么可观察结果证明目标已经实现？",
        recommendedAnswer: "给出至少一条结果描述，以及可观察的测试、界面行为或输出证据。",
        blocker: "acceptance",
      });
    }
  }

  if (snapshot.blockingAmbiguities.length) blockers.push("blocking_ambiguity");
  const activeAmbiguityIds = new Set(snapshot.blockingAmbiguities.map((ambiguity) => ambiguity.id));
  snapshot.blockingAmbiguities.forEach((ambiguity) => {
    if (ambiguity.dependsOn.some((dependency) => activeAmbiguityIds.has(dependency))) return;
    candidates.push({
      id: ambiguity.id,
      title: "消除阻塞歧义",
      question: ambiguity.question,
      recommendedAnswer: ambiguity.recommendedAnswer,
      blocker: "blocking_ambiguity",
    });
  });

  return { ready: blockers.length === 0, blockers, frontier: candidates.slice(0, 3) };
}
