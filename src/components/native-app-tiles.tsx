import type { ReactNode } from "react";

import type { NativeCardId } from "@/lib/native-apps";

import { HighLevelCard } from "./HighLevelCard";
import { McpServersPanel } from "./McpServersPanel";
import { PostizCard } from "./PostizCard";
import { XCard } from "./XCard";

export function nativeAppTiles(props: {
  shown: Record<NativeCardId, boolean>;
  refreshKey: number;
  onWhopConnection: (connected: boolean) => void;
  onFamulorConnection: (connected: boolean) => void;
  onXConnection: (connected: boolean | null) => void;
  onHighLevelConnection: (connected: boolean | null) => void;
  onPostizConnection: (connected: boolean | null) => void;
}): ReactNode {
  const visible = (id: NativeCardId) => props.shown[id] ? "contents" : "hidden";
  return (
    <>
      <div className={visible("whop")}>
        <McpServersPanel whopCard refreshKey={props.refreshKey} onWhopConnection={props.onWhopConnection} />
      </div>
      <div data-native-card="famulor" className={visible("famulor")}>
        <McpServersPanel nativeCard="famulor" refreshKey={props.refreshKey} onNativeConnection={props.onFamulorConnection} />
      </div>
      <div data-native-card="x" className={visible("x")}><XCard refreshKey={props.refreshKey} onConnection={props.onXConnection} /></div>
      <div data-native-card="highlevel" className={visible("highlevel")}>
        <HighLevelCard refreshKey={props.refreshKey} onConnection={props.onHighLevelConnection} />
      </div>
      <div data-native-card="postiz" className={visible("postiz")}><PostizCard refreshKey={props.refreshKey} onConnection={props.onPostizConnection} /></div>
    </>
  );
}
