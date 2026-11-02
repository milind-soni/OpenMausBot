import { t } from "@/lib/i18n";

/** Server container-computer status strings are English wire text; show them in the UI locale when we recognize them. */
export function localizedContainerProblem(problem: string | null | undefined): string | null {
  if (problem == null || problem === "") return null;
  const prepare = /^Prepare the Cua desktop image with Driver (.+)$/.exec(problem);
  if (prepare) return t("vm.problem.prepareImage", { driver: prepare[1]! });
  return problem;
}
