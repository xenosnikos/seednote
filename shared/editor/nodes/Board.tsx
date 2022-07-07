import { NodeSpec, NodeType } from "prosemirror-model";
import Node from "./Node";
import toggleWrap from "../commands/toggleWrap";

export default class Board extends Node {
    get name() {
        return "board";
    }

    get schema(): NodeSpec {
        return {
            content: "board+",
            group: "board",
            defining: true,
            parseDOM: [
                { tag: "board" }
            ],
            toDOM: () => ["board", 0]
        }
    }

    commands({ type }: { type: NodeType }) {
        return () => toggleWrap(type);
    }

    parseMarkdown() {
        return { block: "board" };
    }
}