import { schema } from "../schema";
import { Node } from "prosemirror-model";
import { parseFountain } from "./fountain";

/**
 * Scene data for importing into the editor.
 * Only `heading` and `action_content` are used by the importer.
 * Other fields are passed through for compatibility with host applications.
 */
export interface SceneData {
  /** Scene heading text (e.g. "INT. OFFICE - DAY") */
  heading: string;
  /** Fountain-formatted scene content (action, dialogue, etc.) */
  action_content: string;
  scene_number?: number;
  int_ext?: string;
  location?: string;
  time_of_day?: string;
  characters?: string[];
  dialogue_count?: number;
  estimated_pages?: number;
}

// Convert a scene array to ProseMirror document
export function scenesToDoc(scenes: SceneData[]): Node {
  const nodes: Node[] = [];

  for (const scene of scenes) {
    // Scene heading
    if (scene.heading) {
      const headingText = scene.heading.toUpperCase();
      nodes.push(schema.nodes.sceneHeading.create({}, schema.text(headingText)));
    }

    // action_content is fountain-like text: action paragraphs + CHARACTER\nDialogue blocks
    if (scene.action_content) {
      const elements = parseFountain(scene.action_content);
      for (const el of elements) {
        const nodeType = schema.nodes[el.type];
        const content = el.text ? schema.text(el.text) : undefined;
        nodes.push(nodeType.create({}, content));
      }
    }
  }

  if (nodes.length === 0) {
    nodes.push(schema.nodes.action.create());
  }

  return schema.nodes.doc.create({}, nodes);
}
