/** Portable, illustrative fixtures: composed from the same public catalog. */
export const INTERACTIVE_CHOICE_EXAMPLE = `$depth = "Review the approach";
$notes = "";
$hours = 2;
root = Card("Explore a work plan", [Text("Adjust the plan locally and inspect the estimate before adding a request to your reply."), Choice("Next step", ["Review the approach", "Implement the change", "Compare alternatives"], $depth), Slider("Time budget", 1, 8, 1, $hours), Metric("Estimated sections", $hours * 3, "sections"), Text("Plan preview: " + $depth + " within " + $hours + " hours."), Input("Anything to focus on?", $notes), Draft($depth + ". Time budget: " + $hours + " hours. " + $notes)]);`;

export const INTERACTIVE_HEATMAP_EXAMPLE = `$threshold = 0;
root = Card("Activity by day and time", [Text("Illustrative data. Adjust the minimum activity to filter the cells instantly."), Slider("Minimum activity", 0, 12, 1, $threshold), Heatmap("Sessions", ["Mon", "Tue", "Wed", "Thu", "Fri"], ["08", "10", "12", "14", "16", "18"], [[1,5,8,3,2,0],[3,7,5,2,6,1],[4,12,9,5,3,2],[2,6,8,4,1,0],[1,4,3,2,0,0]], $threshold), Chart("Daily totals", ["Mon", "Tue", "Wed", "Thu", "Fri"], [{name:"Sessions", values:[19,24,35,21,10]}], "bar")]);`;

export const INTERACTIVE_COMPARE_EXAMPLE = `$seats = 3;
$annual = true;
$features = ["Documents"];
root = Stack([Heading("Compare the options"), Text("Sample prices, not a purchase offer."), Grid([NumberInput("People", 1, 30, 1, $seats), Toggle("Annual billing", $annual)]), MultiChoice("Useful features", ["Documents", "Charts", "Shared review"], $features), Grid([Card("Basic", [Metric("Monthly total", $seats * 10, "USD"), Text("Core editing and documents")]), Card("Team", [Metric("Monthly total", $seats * ($annual ? 16 : 20), "USD"), Text("Shared review and charts")])]), Table(["Plan", "Support"], [["Basic", "Community"], ["Team", "Priority"]]), Details("How to choose", [Flow("Decision process", [{label:"Needs",detail:"List the capabilities you actually use."},{label:"Budget",detail:"Compare the total cost for everyone on the team."},{label:"Trial",detail:"Try the preferred option before committing."}])]), Draft("Help me compare plans for " + $seats + " people.")]);`;
