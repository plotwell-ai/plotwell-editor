// Scene Insertion Service - Handle inserting AI-generated scenes into TipTap documents
import { createClient } from '@supabase/supabase-js';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface TipTapDocument {
  type: 'doc';
  content: TipTapNode[];
}

export interface TipTapNode {
  type: string;
  attrs?: { [key: string]: any };
  content?: TipTapTextNode[];
  text?: string;
}

export interface TipTapTextNode {
  type: 'text';
  text: string;
  marks?: any[];
}

export interface SceneInsertionOptions {
  scriptId: string;
  sceneId: string;
  insertPosition: 'beginning' | 'end' | 'after' | 'before';
  targetNodeIndex?: number; // For 'after', 'before', 'replace' positions
  userId: string;
  projectId: string;
}

export interface SceneInsertionResult {
  success: boolean;
  updatedScript?: TipTapDocument;
  scriptId?: string;
  insertedAt?: number;
  error?: string;
}

export class SceneInsertionService {
  /**
   * Insert an AI-generated scene into a script at the specified position
   */
  static async insertScene(options: SceneInsertionOptions): Promise<SceneInsertionResult> {
    try {
      const { scriptId, sceneId, insertPosition, targetNodeIndex, userId, projectId } = options;

      // 1. Fetch the scene to be inserted
      const { data: scene, error: sceneError } = await supabase
        .from('ai_generated_scenes')
        .select('*')
        .eq('id', sceneId)
        .eq('project_id', projectId) // Security check
        .single();

      if (sceneError || !scene) {
        return { success: false, error: `Scene not found: ${sceneError?.message}` };
      }

      // 2. Fetch the current script
      const { data: script, error: scriptError } = await supabase
        .from('scripts')
        .select('*')
        .eq('id', scriptId)
        .eq('project_id', projectId) // Security check
        .single();

      if (scriptError || !script) {
        return { success: false, error: `Script not found: ${scriptError?.message}` };
      }

      // 3. Parse the documents
      const sceneDoc = scene.content as TipTapDocument;
      const scriptDoc = script.content as TipTapDocument;

      if (!sceneDoc?.content || !scriptDoc?.content) {
        return { success: false, error: 'Invalid document structure' };
      }

      // CRITICAL: Validate that script has actual content (not just empty array)
      // This prevents the merge from replacing the entire script with just the scene
      if (!Array.isArray(scriptDoc.content) || scriptDoc.content.length === 0) {
        console.error('❌ SCENE INSERTION BLOCKED: Script content is empty', {
          scriptId,
          sceneId,
          scriptContentType: typeof scriptDoc.content,
          scriptContentLength: Array.isArray(scriptDoc.content) ? scriptDoc.content.length : 'not array'
        });
        return {
          success: false,
          error: 'Cannot insert scene: Script content is empty. Please add content to your script first.'
        };
      }

      // Sanitize scene content to remove empty text nodes (TipTap rejects these)
      const sanitizedSceneDoc = this.sanitizeDocument(sceneDoc);

      if (DEBUG_AI) console.log('📋 SCENE INSERTION DEBUG:', {
        insertPosition,
        targetNodeIndex,
        scriptContentLength: scriptDoc.content.length,
        sceneContentLength: sanitizedSceneDoc.content.length,
        firstScriptNode: scriptDoc.content[0]?.attrs?.class,
        scriptSceneHeadings: scriptDoc.content.filter(n => (n.attrs?.class || '').includes('scene-heading')).length
      });

      // 4. Perform the insertion
      const updatedScript = this.performInsertion(
        scriptDoc,
        sanitizedSceneDoc,
        insertPosition,
        targetNodeIndex
      );

      if (!updatedScript) {
        return { success: false, error: 'Failed to insert scene into script' };
      }

      // 5. Create a new version of the script (following the version control system)
      const versionNumber = await this.getNextVersionNumber(scriptId);
      
      // 6. Save the updated script
      const { data: updatedScriptData, error: updateError } = await supabase
        .from('scripts')
        .update({
          content: updatedScript,
          updated_at: new Date().toISOString()
        })
        .eq('id', scriptId)
        .select()
        .single();

      if (updateError) {
        return { success: false, error: `Failed to update script: ${updateError.message}` };
      }

      // 7. Create version entry
      await supabase
        .from('script_versions')
        .insert({
          script_id: scriptId,
          version_number: versionNumber,
          title: script.title,
          content: updatedScript,
          change_summary: `Inserted scene: ${scene.heading}`,
          created_by: userId
        });

      // 8. Update scene status to 'inserted'
      await supabase
        .from('ai_generated_scenes')
        .update({
          status: 'inserted',
          generation_metadata: {
            ...scene.generation_metadata,
            inserted_at: new Date().toISOString(),
            inserted_into_script: scriptId,
            insert_position: insertPosition
          }
        })
        .eq('id', sceneId);

      return {
        success: true,
        updatedScript,
        scriptId,
        insertedAt: this.findInsertionPoint(scriptDoc, insertPosition, targetNodeIndex)
      };

    } catch (error) {
      console.error('Scene insertion error:', error);
      return { 
        success: false, 
        error: `Insertion failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * Find the node index where a scene ends (the last node before the next scene heading)
   * @param nodes - The TipTap document content nodes
   * @param sceneNumber - The scene number to find (1-based)
   * @returns The index of the last node of that scene, or -1 if not found
   */
  /**
   * Check if a node is a scene heading
   */
  private static isSceneHeading(node: TipTapNode): boolean {
    const nodeClass = node.attrs?.class || '';
    return nodeClass.includes('scene-heading');
  }

  private static findSceneEndIndex(nodes: TipTapNode[], sceneNumber: number): number {
    let currentScene = 0;
    let sceneStartIndex = -1;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isSceneHeading = this.isSceneHeading(node);

      if (isSceneHeading) {
        currentScene++;

        // If we just found the NEXT scene after the target, return the previous index
        if (currentScene > sceneNumber && sceneStartIndex !== -1) {
          return i - 1;
        }

        // Mark where the target scene starts
        if (currentScene === sceneNumber) {
          sceneStartIndex = i;
        }
      }
    }

    // If we found the target scene but no next scene, the scene goes to the end
    if (sceneStartIndex !== -1) {
      return nodes.length - 1;
    }

    return -1;
  }

  /**
   * Perform the actual insertion of scene content into script content
   */
  private static performInsertion(
    scriptDoc: TipTapDocument,
    sceneDoc: TipTapDocument,
    position: string,
    targetSceneNumber?: number
  ): TipTapDocument | null {
    try {
      const scriptContent = [...scriptDoc.content];
      const sceneContent = [...sceneDoc.content];

      // Add a separator comment before the inserted scene
      const separator: TipTapNode = {
        type: 'paragraph',
        attrs: { class: 'action' },
        content: [{
          type: 'text',
          text: `// --- AI Generated Scene Inserted ---`
        }]
      };

      let insertIndex: number;

      switch (position) {
        case 'beginning':
          insertIndex = 0;
          break;

        case 'end':
          insertIndex = scriptContent.length;
          break;

        case 'after':
          // targetSceneNumber is now a scene number (1, 2, 3), not a node index
          if (targetSceneNumber === undefined || targetSceneNumber < 1) {
            console.error('❌ Invalid target scene number for "after" position:', targetSceneNumber);
            return null;
          }
          // Find the last node of the target scene
          const sceneEndIndex = this.findSceneEndIndex(scriptContent, targetSceneNumber);
          if (DEBUG_AI) console.log(`🔍 Finding scene ${targetSceneNumber} end: found at node index ${sceneEndIndex}`);

          // Log all scene headings for debugging
          if (DEBUG_AI) {
            const sceneHeadings = scriptContent
              .map((n, i) => this.isSceneHeading(n) ? { index: i, class: n.attrs?.class, text: n.content?.[0]?.text } : null)
              .filter(Boolean);
            console.log('📜 Script scene headings:', sceneHeadings);
          }

          if (sceneEndIndex === -1) {
            console.error('❌ Could not find scene', targetSceneNumber, 'in script');
            // Fallback: insert at end if scene not found
            insertIndex = scriptContent.length;
          } else {
            insertIndex = sceneEndIndex + 1;
          }
          if (DEBUG_AI) console.log(`📍 Inserting after scene ${targetSceneNumber} at node index ${insertIndex} (total nodes: ${scriptContent.length})`);
          break;

        case 'before':
          if (targetSceneNumber === undefined || targetSceneNumber < 1) {
            return null;
          }
          // Find where the target scene starts
          let sceneCount = 0;
          insertIndex = 0;
          for (let i = 0; i < scriptContent.length; i++) {
            if (this.isSceneHeading(scriptContent[i])) {
              sceneCount++;
              if (sceneCount === targetSceneNumber) {
                insertIndex = i;
                break;
              }
            }
          }
          break;

        default:
          return null;
      }

      // Insert the separator and scene content
      scriptContent.splice(insertIndex, 0, separator, ...sceneContent);

      // CRITICAL SAFETY CHECK: Ensure we're not returning just the scene content
      // The merged content should always have more nodes than just the scene
      const originalScriptNodeCount = scriptDoc.content.length;
      if (scriptContent.length <= sceneContent.length + 1) {
        console.error('❌ SCENE MERGE SAFETY CHECK FAILED: Result seems to be just the scene', {
          originalScriptNodeCount,
          sceneNodeCount: sceneContent.length,
          resultNodeCount: scriptContent.length
        });
        // Don't return null here - log the warning but still allow if there's actual content
      }

      return {
        type: 'doc',
        content: scriptContent
      };

    } catch (error) {
      console.error('Insertion operation failed:', error);
      return null;
    }
  }

  /**
   * Find where the insertion will occur (for response metadata)
   */
  private static findInsertionPoint(
    scriptDoc: TipTapDocument,
    position: string,
    targetIndex?: number
  ): number {
    switch (position) {
      case 'beginning':
        return 0;
      case 'end':
        return scriptDoc.content.length;
      case 'after':
        return (targetIndex !== undefined) ? targetIndex + 1 : -1;
      case 'before':
      case 'replace':
        return targetIndex !== undefined ? targetIndex : -1;
      default:
        return -1;
    }
  }

  /**
   * Sanitize a TipTap document to remove empty text nodes
   * TipTap/ProseMirror rejects documents with empty text nodes
   */
  private static sanitizeDocument(doc: TipTapDocument): TipTapDocument {
    const sanitizeNode = (node: TipTapNode): TipTapNode | null => {
      // If this is a text node with empty text, remove it
      if (node.type === 'text' && (!node.text || node.text === '')) {
        return null;
      }

      // If node has content array, recursively sanitize and filter out nulls
      if (node.content && Array.isArray(node.content)) {
        const sanitizedContent = node.content
          .map(child => sanitizeNode(child as TipTapNode))
          .filter((child): child is TipTapNode => child !== null);

        // If the paragraph/node ends up with no content, keep it but with minimal content
        // (empty paragraphs are valid, but paragraphs with empty text nodes are not)
        return {
          ...node,
          content: sanitizedContent.length > 0 ? sanitizedContent as TipTapTextNode[] : undefined
        };
      }

      return node;
    };

    const sanitizedContent = doc.content
      .map(node => sanitizeNode(node))
      .filter((node): node is TipTapNode => node !== null);

    return {
      type: 'doc',
      content: sanitizedContent
    };
  }

  /**
   * Get the next version number for script versioning
   */
  private static async getNextVersionNumber(scriptId: string): Promise<number> {
    const { data, error } = await supabase
      .from('script_versions')
      .select('version_number')
      .eq('script_id', scriptId)
      .order('version_number', { ascending: false })
      .limit(1);

    if (error) {
      console.error('Error getting version number:', error);
      return 1;
    }

    return data && data.length > 0 ? data[0].version_number + 1 : 1;
  }

  /**
   * Get a preview of what the script will look like after insertion (without saving)
   */
  static async previewInsertion(options: SceneInsertionOptions): Promise<{
    success: boolean;
    preview?: TipTapDocument;
    error?: string;
  }> {
    try {
      const { scriptId, sceneId, insertPosition, targetNodeIndex, projectId } = options;

      // Fetch scene and script
      const [sceneResult, scriptResult] = await Promise.all([
        supabase.from('ai_generated_scenes').select('content').eq('id', sceneId).eq('project_id', projectId).single(),
        supabase.from('scripts').select('content').eq('id', scriptId).eq('project_id', projectId).single()
      ]);

      if (sceneResult.error || scriptResult.error) {
        return { success: false, error: 'Failed to fetch documents' };
      }

      const sceneDoc = sceneResult.data.content as TipTapDocument;
      const scriptDoc = scriptResult.data.content as TipTapDocument;

      const preview = this.performInsertion(scriptDoc, sceneDoc, insertPosition, targetNodeIndex);

      if (!preview) {
        return { success: false, error: 'Failed to generate preview' };
      }

      return { success: true, preview };

    } catch (error) {
      return { 
        success: false, 
        error: `Preview failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * List available insertion points in a script for UI purposes
   */
  static async getInsertionPoints(scriptId: string, projectId: string): Promise<{
    success: boolean;
    points?: Array<{
      index: number;
      description: string;
      nodeType: string;
      preview: string;
    }>;
    error?: string;
  }> {
    try {
      const { data: script, error } = await supabase
        .from('scripts')
        .select('content')
        .eq('id', scriptId)
        .eq('project_id', projectId)
        .single();

      if (error || !script) {
        return { success: false, error: 'Script not found' };
      }

      const scriptDoc = script.content as TipTapDocument;
      if (!scriptDoc?.content) {
        return { success: false, error: 'Invalid script structure' };
      }

      const points = scriptDoc.content.map((node, index) => {
        const nodeText = this.getNodePreviewText(node);
        const nodeClass = node.attrs?.class || node.type;
        
        return {
          index,
          description: `${nodeClass}: ${nodeText.substring(0, 50)}${nodeText.length > 50 ? '...' : ''}`,
          nodeType: nodeClass,
          preview: nodeText.substring(0, 100)
        };
      });

      return { success: true, points };

    } catch (error) {
      return { 
        success: false, 
        error: `Failed to get insertion points: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * Extract text content from a TipTap node for preview purposes
   */
  private static getNodePreviewText(node: TipTapNode): string {
    if (node.text) {
      return node.text;
    }

    if (node.content && Array.isArray(node.content)) {
      return node.content
        .map(child => child.text || '')
        .join(' ')
        .trim();
    }

    return `[${node.type}]`;
  }
}