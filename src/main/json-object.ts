import { parseTree, type Node, type ParseError } from "jsonc-parser";

export function parseJsonObjectTree(text: string, label: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || root?.type !== "object") throw new Error(`${label} must contain a valid JSON object.`);

  function checkDuplicates(node: Node): void {
    if (node.type === "object") {
      const keys = node.children!.map((property) => property.children![0].value);
      if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicate object keys.`);
    }
    for (const child of node.children ?? []) checkDuplicates(child);
  }
  checkDuplicates(root);
  return root;
}

export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  parseJsonObjectTree(text, label);
  return JSON.parse(text) as Record<string, unknown>;
}
