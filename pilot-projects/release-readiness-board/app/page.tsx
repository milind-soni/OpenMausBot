import type { Metadata } from "next";
import { ReleaseBoard } from "./release-board";

export const metadata: Metadata = {
  title: "Release Room · 发布验收室",
  description: "非生产发布的可视化验收看板。",
};

export default function Home() {
  return <ReleaseBoard />;
}
