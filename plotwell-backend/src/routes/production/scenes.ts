import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireSyncedScenes } from '../../middleware/productionPrerequisitesMiddleware';
import { attachProductionStatus } from '../../middleware/productionPrerequisitesMiddleware';
import { ProductionAnalysisService } from '../../services/productionAnalysisService';
import { ScriptParsingService } from '../../services/scriptParsingService';
import { syncProductionWithScript, lockScene, getSyncStatus } from '../../services/productionSyncServiceSimple';
import { generateSceneId } from '../../services/sceneIdentityService';
import { getUserId, checkProjectAccessForUser, supabase } from './helpers';
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

// Get editable production data
router.get('/data/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;

    const data = await ProductionAnalysisService.getEditableAnalysisData(
      projectId,
      getUserId(req)
    );

    res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error('Failed to get production data:', error);
    res.status(500).json({
      error: 'Failed to get production data',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Update scene card
router.put('/scene-card/:sceneId', requireAuth, async (req, res) => {
  try {
    const { sceneId } = req.params;
    const updates = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get scene card to find project_id, then verify access
    const { data: sceneCard, error: fetchError } = await supabase
      .from('scene_cards')
      .select('project_id')
      .eq('id', sceneId)
      .single();

    if (fetchError || !sceneCard) {
      return res.status(404).json({ error: 'Scene card not found' });
    }

    const access = await checkProjectAccessForUser(sceneCard.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot edit scene cards' });
    }

    const updatedScene = await ProductionAnalysisService.updateSceneCard(
      sceneId,
      userId,
      updates
    );

    res.json({
      success: true,
      sceneCard: updatedScene
    });

  } catch (error) {
    console.error('Failed to update scene card:', error);
    res.status(500).json({
      error: 'Failed to update scene card',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete scene card
router.delete('/scene-card/:sceneId', requireAuth, async (req, res) => {
  try {
    const { sceneId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get scene card to find project_id
    const { data: sceneCard, error: fetchError } = await supabase
      .from('scene_cards')
      .select('project_id')
      .eq('id', sceneId)
      .single();

    if (fetchError || !sceneCard) {
      return res.status(404).json({ error: 'Scene card not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(sceneCard.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete scene cards' });
    }

    const { error } = await supabase
      .from('scene_cards')
      .delete()
      .eq('id', sceneId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Scene card deleted successfully'
    });

  } catch (error) {
    console.error('Failed to delete scene card:', error);
    res.status(500).json({
      error: 'Failed to delete scene card',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Add new scene card manually
router.post('/scene-card', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { project_id, projectId } = req.body;
    const effectiveProjectId = project_id || projectId;

    if (!effectiveProjectId) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Verify project access
    const access = await checkProjectAccessForUser(effectiveProjectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot create scene cards', role: access.role });
    }

    const sceneData = {
      ...req.body,
      user_id: userId
    };

    const { data, error } = await supabase
      .from('scene_cards')
      .insert(sceneData)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      sceneCard: data
    });

  } catch (error) {
    console.error('Failed to create scene card:', error);
    res.status(500).json({
      error: 'Failed to create scene card',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get budget items for a project (grouped by category)
// Supports optional ?episode_id= query param for TV series episode-level budgets
router.get('/budget/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const episodeId = req.query.episode_id as string | undefined;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check project access
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build query — filter by episode_id when provided, otherwise get project-level items (episode_id IS NULL)
    let query = supabase
      .from('production_budgets')
      .select('*')
      .eq('project_id', projectId)
      .order('category_name');

    if (episodeId) {
      query = query.eq('episode_id', episodeId);
    } else {
      query = query.is('episode_id', null);
    }

    const { data: budgetItems, error } = await query;

    if (error) throw error;

    // Group items by category_name
    const budget: Record<string, any[]> = {};
    for (const item of budgetItems || []) {
      const categoryName = item.category_name || 'Uncategorized';
      if (!budget[categoryName]) {
        budget[categoryName] = [];
      }
      budget[categoryName].push({
        id: item.id,
        name: item.item_name,
        description: item.notes,
        quantity: item.quantity,
        rate: item.rate,
        unit: item.unit,
        total: item.total,
        is_estimated: item.is_estimated
      });
    }

    res.json({ budget });

  } catch (error) {
    console.error('Failed to fetch budget:', error);
    res.status(500).json({
      error: 'Failed to fetch budget',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Update budget item
router.put('/budget-item/:itemId', requireAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const updates = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get budget item to find project_id, then verify access
    const { data: budgetItem, error: fetchError } = await supabase
      .from('production_budgets')
      .select('project_id')
      .eq('id', itemId)
      .single();

    if (fetchError || !budgetItem) {
      return res.status(404).json({ error: 'Budget item not found' });
    }

    const access = await checkProjectAccessForUser(budgetItem.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot edit budget items' });
    }

    const updatedItem = await ProductionAnalysisService.updateBudgetItem(
      itemId,
      userId,
      updates
    );

    res.json({
      success: true,
      budgetItem: updatedItem
    });

  } catch (error) {
    console.error('Failed to update budget item:', error);
    res.status(500).json({
      error: 'Failed to update budget item',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete all budget items in a category in one request
router.delete('/budget-category', requireAuth, async (req, res) => {
  try {
    const { project_id: projectId, category_name: categoryName, episode_id: episodeId } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!projectId || !categoryName) {
      return res.status(400).json({ error: 'Missing required fields: project_id, category_name' });
    }

    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete budget categories' });
    }

    let query = supabase
      .from('production_budgets')
      .delete()
      .eq('project_id', projectId)
      .eq('category_name', categoryName);

    query = episodeId
      ? query.eq('episode_id', episodeId)
      : query.is('episode_id', null);

    const { data: deletedItems, error } = await query.select('id');

    if (error) throw error;

    res.json({
      success: true,
      deletedCount: deletedItems?.length || 0,
      message: 'Budget category deleted successfully'
    });

  } catch (error) {
    console.error('Failed to delete budget category:', error);
    res.status(500).json({
      error: 'Failed to delete budget category',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete budget item
router.delete('/budget-item/:itemId', requireAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get budget item to find project_id
    const { data: budgetItem, error: fetchError } = await supabase
      .from('production_budgets')
      .select('project_id')
      .eq('id', itemId)
      .single();

    if (fetchError || !budgetItem) {
      return res.status(404).json({ error: 'Budget item not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(budgetItem.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete budget items' });
    }

    const { error } = await supabase
      .from('production_budgets')
      .delete()
      .eq('id', itemId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Budget item deleted successfully'
    });

  } catch (error) {
    console.error('Failed to delete budget item:', error);
    res.status(500).json({
      error: 'Failed to delete budget item',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Add new budget item manually
router.post('/budget-item', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { category, project_id, projectId, ...restBody } = req.body;
    const effectiveProjectId = project_id || projectId;

    if (!effectiveProjectId) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Verify project access
    const access = await checkProjectAccessForUser(effectiveProjectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot create budget items', role: access.role });
    }

    const budgetData = {
      ...restBody,
      project_id: effectiveProjectId,
      category_name: category || restBody.category_name,
      user_id: userId,
      is_estimated: false // Manually created items are not estimates
    };

    const { data, error } = await supabase
      .from('production_budgets')
      .insert(budgetData)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      budgetItem: data
    });

  } catch (error) {
    console.error('Failed to create budget item:', error);
    res.status(500).json({
      error: 'Failed to create budget item',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Create schedule from scenes
router.post('/create-schedule', requireAuth, async (req, res) => {
  try {
    const { projectId, sceneIds } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (write required)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot create schedules' });
    }

    const scheduleItems = await ProductionAnalysisService.createScheduleFromScenes(
      projectId,
      userId,
      sceneIds
    );

    res.json({
      success: true,
      scheduleItems,
      count: scheduleItems.length
    });

  } catch (error) {
    console.error('Failed to create schedule:', error);
    res.status(500).json({
      error: 'Failed to create schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Import scenes from script to production
// Preview script scenes without importing
router.get('/preview-script-scenes/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { script_id, episode_id } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Parse script and extract scenes.
    // For episodic projects (e.g. vertical series), the script lives on the
    // episode, so forward episode_id; otherwise falls back to prod_script_id.
    const result = await ScriptParsingService.parseScriptFromProject(
      projectId,
      userId,
      script_id as string | undefined,
      episode_id as string | undefined
    );

    if (!result) {
      // No script for this project/episode yet (valid state for new episodes)
      return res.json({
        success: true,
        scenes: [],
        storyboardScenes: [],
        scriptTitle: '',
        scriptId: null,
        scenesCount: 0
      });
    }

    const { scenes, storyboardScenes, scriptTitle, scriptId } = result;

    res.json({
      success: true,
      scenes,
      storyboardScenes,
      scriptTitle,
      scriptId,
      scenesCount: scenes.length
    });

  } catch (error) {
    console.error('Script preview error:', error);
    res.status(500).json({
      error: 'Failed to preview script scenes',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Update project language settings
router.put('/projects/:projectId/settings', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { projectId } = req.params;
    const { language, content_language } = req.body;


    const updateData = {
      language: language || 'en',
      content_language: content_language || 'en',
      updated_at: new Date().toISOString()
    };


    // Update project settings in the database
    const { data, error } = await supabase
      .from('projects')
      .update(updateData)
      .eq('id', projectId)
      .eq('user_id', userId) // Ensure user owns the project
      .select()
      .single();

    if (error) {
      console.error('❌ PROJECT SETTINGS UPDATE ERROR:', {
        error: error,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        projectId,
        userId,
        updateData
      });
      return res.status(500).json({ error: 'Failed to update project settings' });
    }

    res.json({ project: data });
  } catch (error) {
    console.error('Project settings update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available production locations for the user's projects
router.get('/locations', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { data, error } = await supabase
      .from('production_locations')
      .select(`
        id,
        name,
        address,
        location_type,
        contact_info,
        permits_required,
        cost_per_day,
        availability_dates,
        project_id,
        projects:project_id (
          name,
          id
        )
      `)
      .eq('user_id', userId)
      .order('name');

    if (error) throw error;

    // Group by project for easier selection
    const groupedByProject = data.reduce((acc: any, location: any) => {
      const projectName = location.projects?.name || 'Unknown Project';
      if (!acc[projectName]) {
        acc[projectName] = [];
      }
      acc[projectName].push(location);
      return acc;
    }, {});

    res.json({
      success: true,
      locations: data,
      groupedByProject
    });

  } catch (error) {
    console.error('Error fetching production locations:', error);
    res.status(500).json({
      error: 'Failed to fetch production locations',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get a specific production location by ID
router.get('/locations/:locationId', requireAuth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { data, error } = await supabase
      .from('production_locations')
      .select(`
        *,
        projects:project_id (
          name,
          id
        )
      `)
      .eq('id', locationId)
      .eq('user_id', userId)
      .single();

    if (error) {
      return res.status(404).json({
        error: 'Location not found',
        details: 'No location found with this ID or access denied'
      });
    }

    res.json({
      success: true,
      location: data
    });

  } catch (error) {
    console.error('Error fetching production location:', error);
    res.status(500).json({
      error: 'Failed to fetch production location',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get project location settings
router.get('/project-location/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Check access (owner or collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: project, error } = await supabase
      .from('projects')
      .select('production_country, production_region, production_city, production_scope, currency, cost_multiplier, language, content_language')
      .eq('id', projectId)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ project });
  } catch (error) {
    console.error('Error fetching project location:', error);
    res.status(500).json({ error: 'Failed to fetch project location' });
  }
});

// Update project location settings
router.put('/project-location/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const {
      production_country,
      production_region,
      production_city,
      production_scope,
      currency,
      cost_multiplier,
      language,
      content_language
    } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Check access (owner or collaborator with edit permission)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess || !access.canEdit) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build update object, only including defined fields
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (production_country !== undefined) updateData.production_country = production_country;
    if (production_region !== undefined) updateData.production_region = production_region;
    if (production_city !== undefined) updateData.production_city = production_city;
    if (production_scope !== undefined) updateData.production_scope = production_scope;
    if (currency !== undefined) updateData.currency = currency;
    if (cost_multiplier !== undefined) updateData.cost_multiplier = cost_multiplier;
    if (language !== undefined) updateData.language = language;
    if (content_language !== undefined) updateData.content_language = content_language;

    const { data, error } = await supabase
      .from('projects')
      .update(updateData)
      .eq('id', projectId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      project: data,
      message: 'Project location settings updated successfully'
    });

  } catch (error) {
    console.error('Error updating project location:', error);
    res.status(500).json({
      error: 'Failed to update project location',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =====================================================
// PRODUCTION LOCATIONS CRUD ENDPOINTS
// =====================================================

// Get production locations for a project
router.get('/production-locations/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied or project not found' });
    }

    // Get production locations (optionally filtered by season_id)
    const seasonId = req.query.season_id as string | undefined;
    let locQuery = supabase
      .from('production_locations')
      .select('*')
      .eq('project_id', projectId);

    if (seasonId) {
      locQuery = locQuery.eq('season_id', seasonId);
    } else {
      locQuery = locQuery.is('season_id', null);
    }

    const { data: locations, error } = await locQuery.order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching production locations:', error);
      return res.status(500).json({ error: 'Failed to fetch production locations' });
    }

    // For each production location, get linked story locations
    const locationsWithLinks = await Promise.all(
      (locations || []).map(async (loc) => {
        const { data: linkedLocations } = await supabase
          .from('locations')
          .select('id, name, location_type, story_importance')
          .eq('project_id', projectId)
          .eq('production_location_id', loc.id);

        return {
          ...loc,
          linked_story_locations: linkedLocations || []
        };
      })
    );

    res.json({
      success: true,
      locations: locationsWithLinks
    });

  } catch (error) {
    console.error('Error in production locations GET:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new production location
router.post('/production-locations', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const {
      project_id,
      name,
      address,
      location_type,
      country,
      contact_info,
      permits_required,
      cost_per_day,
      availability_dates,
      notes,
      season_id
    } = req.body;

    // Validate required fields
    if (!project_id || !name) {
      return res.status(400).json({ error: 'project_id and name are required' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied or project not found' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot create production locations' });
    }

    // Create the production location
    const insertData: Record<string, any> = {
      project_id,
      user_id: userId,
      name,
      address,
      location_type,
      country,
      contact_info: contact_info || {},
      permits_required: permits_required || false,
      cost_per_day: cost_per_day ? parseInt(cost_per_day) : null,
      availability_dates,
      notes
    };
    if (season_id) insertData.season_id = season_id;

    const { data: location, error } = await supabase
      .from('production_locations')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error creating production location:', error);
      return res.status(500).json({ error: 'Failed to create production location' });
    }

    res.json({
      success: true,
      location
    });

  } catch (error) {
    console.error('Error in production locations POST:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a production location
router.put('/production-locations/:locationId', requireAuth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const {
      name,
      address,
      location_type,
      country,
      contact_info,
      permits_required,
      cost_per_day,
      availability_dates,
      notes,
      season_id
    } = req.body;

    // Get the production location to find its project_id
    const { data: existingLocation, error: verifyError } = await supabase
      .from('production_locations')
      .select('project_id')
      .eq('id', locationId)
      .single();

    if (verifyError || !existingLocation) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingLocation.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot update production locations' });
    }

    // Update the production location
    const updateData: Record<string, any> = {
      name,
      address,
      location_type,
      country,
      contact_info,
      permits_required,
      cost_per_day: cost_per_day ? parseInt(cost_per_day) : null,
      availability_dates,
      notes,
      updated_at: new Date().toISOString()
    };
    if (season_id !== undefined) updateData.season_id = season_id || null;

    const { data: location, error } = await supabase
      .from('production_locations')
      .update(updateData)
      .eq('id', locationId)
      .select()
      .single();

    if (error) {
      console.error('Error updating production location:', error);
      return res.status(500).json({ error: 'Failed to update production location' });
    }

    res.json({
      success: true,
      location
    });

  } catch (error) {
    console.error('Error in production locations PUT:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a production location
router.delete('/production-locations/:locationId', requireAuth, async (req, res) => {
  try {
    const { locationId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Get the production location to find its project_id
    const { data: existingLocation, error: verifyError } = await supabase
      .from('production_locations')
      .select('project_id')
      .eq('id', locationId)
      .single();

    if (verifyError || !existingLocation) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(existingLocation.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete production locations' });
    }

    // Delete the production location
    const { error } = await supabase
      .from('production_locations')
      .delete()
      .eq('id', locationId);

    if (error) {
      console.error('Error deleting production location:', error);
      return res.status(500).json({ error: 'Failed to delete production location' });
    }

    res.json({
      success: true,
      message: 'Production location deleted successfully'
    });

  } catch (error) {
    console.error('Error in production locations DELETE:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =====================================================
// PRODUCTION SYNC ENDPOINTS
// =====================================================

/**
 * GET /api/production/sync-status/:projectId
 * Get current sync status between script and production
 */
router.get('/sync-status/:projectId', requireAuth, attachProductionStatus, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const status = await getSyncStatus(projectId, userId);

      res.json({
        success: status.success,
        hasChanges: status.hasChanges,
        scriptSceneCount: status.scriptSceneCount,
        productionSceneCount: status.productionSceneCount,
        newScenes: status.newScenes,
        deletedScenes: status.deletedScenes,
        productionStatus: req.productionStatus
      });
    } catch (syncError: any) {
      // If no script exists, return empty sync status
      if (syncError.message?.includes('No script found')) {
        return res.json({
          success: true,
          hasChanges: false,
          scriptSceneCount: 0,
          productionSceneCount: 0,
          newScenes: 0,
          deletedScenes: 0,
          productionStatus: req.productionStatus,
          message: 'No script found'
        });
      }
      throw syncError;
    }

  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      error: 'Failed to get sync status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/production/sync/:projectId
 * Trigger manual sync between script and production
 */
router.post('/sync/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { episode_id } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot sync production', role: access.role });
    }

    // Perform sync (optionally for specific episode)
    const syncResult = await syncProductionWithScript(projectId, userId, episode_id as string | undefined);

    res.json(syncResult);

  } catch (error) {
    console.error('Error syncing production:', error);
    res.status(500).json({
      error: 'Failed to sync production',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/production/resolve-changes/:projectId
 * Apply user decisions from change review modal
 */
/**
 * POST /api/production/scenes/:sceneId/lock
 * Lock a scene to prevent auto-sync
 */
router.post('/scenes/:sceneId/lock', requireAuth, async (req, res) => {
  try {
    const { sceneId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Lookup scene's project_id to verify access
    const { data: scene, error: sceneError } = await supabase
      .from('production_scene_data')
      .select('project_id')
      .eq('id', sceneId)
      .single();

    if (sceneError || !scene) {
      return res.status(404).json({ error: 'Scene not found' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(scene.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot lock scenes', role: access.role });
    }

    await lockScene(sceneId);

    res.json({
      success: true,
      message: 'Scene locked successfully'
    });

  } catch (error) {
    console.error('Error locking scene:', error);
    res.status(500).json({
      error: 'Failed to lock scene',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/production/scenes/:projectId
 * Get production scenes with current script data merged
 */
router.get('/scenes/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { episode_id } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify access: ownership check + collaboration check in parallel
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (project.user_id !== userId) {
      const { data: collaborator, error: collabError } = await supabase
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (collabError || !collaborator) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Parse script ONCE — reuse for sync status and merge
    let scriptScenes: any[] = [];
    let scriptPageCount: number | null = null;

    if (episode_id) {
      const { data: episode } = await supabase
        .from('episodes')
        .select('script_id')
        .eq('id', episode_id)
        .single();

      if (episode?.script_id) {
        const [scriptData, scriptRow] = await Promise.all([
          ScriptParsingService.parseScriptFromProject(projectId, userId, episode.script_id),
          supabase.from('scripts').select('page_count').eq('id', episode.script_id).single(),
        ]);
        scriptScenes = scriptData?.scenes || [];
        scriptPageCount = scriptRow.data?.page_count ?? null;
      }
    } else {
      const scriptData = await ScriptParsingService.parseScriptFromProject(projectId, userId);
      if (scriptData) {
        scriptScenes = scriptData.scenes || [];
        if (scriptData.scriptId) {
          const { data: scriptRow } = await supabase
            .from('scripts').select('page_count').eq('id', scriptData.scriptId).single();
          scriptPageCount = scriptRow?.page_count ?? null;
        }
      }
    }

    // Get production data
    let prodQuery = supabase
      .from('production_scene_data')
      .select('*')
      .eq('project_id', projectId)
      .neq('status', 'archived');

    if (episode_id) {
      prodQuery = prodQuery.eq('episode_id', episode_id);
    }

    const { data: productionScenes, error: prodError } = await prodQuery.order('scene_number');

    if (prodError) {
      console.error('Error fetching production scenes:', prodError);
      return res.status(500).json({ error: 'Failed to fetch production scenes' });
    }

    // Auto-sync if production scenes are missing or count doesn't match script
    const needsSync = scriptScenes.length > 0 && (
      !productionScenes ||
      productionScenes.length === 0 ||
      productionScenes.length !== scriptScenes.length
    );

    if (needsSync) {
      try {
        const syncResult = await syncProductionWithScript(projectId, userId, episode_id as string | undefined);

        // Always re-fetch after sync attempt so scene.id is populated even when hasChanges=false
        if (syncResult.success) {
          let newProdQuery = supabase
            .from('production_scene_data')
            .select('*')
            .eq('project_id', projectId)
            .neq('status', 'archived');

          if (episode_id) {
            newProdQuery = newProdQuery.eq('episode_id', episode_id);
          }

          const { data: newProdScenes, error: newProdError } = await newProdQuery.order('scene_number');

          if (newProdError) {
            console.error('Error fetching new production scenes:', newProdError);
            return res.status(500).json({ error: 'Failed to fetch production scenes after sync' });
          }

          const mergedScenes = mergeScriptAndProductionData(scriptScenes, newProdScenes || []);

          return res.json({
            success: true,
            scenes: mergedScenes,
            script_page_count: scriptPageCount,
            syncStatus: {
              success: true,
              hasChanges: syncResult.hasChanges,
              scriptSceneCount: scriptScenes.length,
              productionSceneCount: newProdScenes?.length || 0,
              newScenes: syncResult.newScenes || 0,
              deletedScenes: syncResult.deletedScenes || 0
            },
            initialized: syncResult.hasChanges,
            syncResult
          });
        }
      } catch (syncError) {
        console.warn('Sync warning:', (syncError as Error).message);
      }
    }

    // Empty state
    if (scriptScenes.length === 0 && (!productionScenes || productionScenes.length === 0)) {
      return res.json({
        success: true,
        scenes: [],
        script_page_count: scriptPageCount,
        syncStatus: { hasChanges: false, scriptSceneCount: 0, productionSceneCount: 0 },
        initialized: false,
        message: 'No script found. Create a script first to use the production planner.'
      });
    }

    // Merge script data with production data
    const mergedScenes = mergeScriptAndProductionData(scriptScenes, productionScenes);

    // Compute sync status inline using already-fetched data (avoid re-parsing script)
    const scriptNumbers = new Set(scriptScenes.map((s: any) => s.scene_number));
    const prodNumbers = new Set((productionScenes || []).map((s: any) => s.scene_number));
    const newScenes = scriptScenes.filter((s: any) => !prodNumbers.has(s.scene_number)).length;
    const deletedScenes = (productionScenes || []).filter((s: any) => !scriptNumbers.has(s.scene_number)).length;

    res.json({
      success: true,
      scenes: mergedScenes,
      script_page_count: scriptPageCount,
      syncStatus: {
        success: true,
        hasChanges: newScenes > 0 || deletedScenes > 0,
        scriptSceneCount: scriptScenes.length,
        productionSceneCount: productionScenes?.length || 0,
        newScenes,
        deletedScenes
      },
      initialized: false
    });

  } catch (error) {
    console.error('Error getting production scenes:', error);
    res.status(500).json({
      error: 'Failed to get production scenes',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PATCH /api/production/scenes/:sceneId
 * Update production scene data fields (complexity, budget, etc.)
 */
router.patch('/scenes/:sceneId', requireAuth, async (req, res) => {
  try {
    const { sceneId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { complexity, estimated_shoot_days, budget_estimate, production_notes, location, shoot_date, call_time, production_location_id, shots } = req.body;

    // Update only the provided fields
    const updateData: any = { updated_at: new Date().toISOString() };
    if (complexity !== undefined) updateData.complexity = complexity;
    if (estimated_shoot_days !== undefined) updateData.estimated_shoot_days = estimated_shoot_days;
    if (budget_estimate !== undefined) updateData.budget_estimate = budget_estimate;
    if (production_notes !== undefined) updateData.production_notes = production_notes;
    if (location !== undefined) updateData.location = location;
    if (shoot_date !== undefined) updateData.shoot_date = shoot_date; // For call sheet scheduling
    if (call_time !== undefined) updateData.call_time = call_time; // General call time for the shoot day
    if (production_location_id !== undefined) updateData.production_location_id = production_location_id; // Link to production location
    if (shots !== undefined) updateData.shots = shots; // Shot list JSONB array

    const { data: scene, error } = await supabase
      .from('production_scene_data')
      .update(updateData)
      .eq('id', sceneId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('[PATCH /scenes] Error updating scene:', error);
      return res.status(500).json({ error: 'Failed to update scene' });
    }

    res.json({
      success: true,
      scene
    });

  } catch (error) {
    console.error('Error updating production scene:', error);
    res.status(500).json({
      error: 'Failed to update production scene',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Helper function to merge script data with production data
 */
function mergeScriptAndProductionData(scriptScenes: any[], productionScenes: any[]): any[] {
  const mergedScenes = [];

  // Create a map of production scenes by scene_number for fast lookup
  const prodSceneMap = new Map();
  for (const prodScene of productionScenes) {
    prodSceneMap.set(prodScene.scene_number, prodScene);
  }


  // Merge each script scene with its production data
  for (const scriptScene of scriptScenes) {
    const sceneId = generateSceneId(scriptScene);
    const prodScene = prodSceneMap.get(scriptScene.scene_number);

    mergedScenes.push({
      // IDs
      id: prodScene?.id || null,
      sceneId: sceneId,

      // Script data (always from script)
      number: scriptScene.scene_number,
      heading: scriptScene.heading,
      timeOfDay: scriptScene.time_of_day,
      intExt: scriptScene.int_ext,
      characters: scriptScene.characters,
      actionContent: scriptScene.action_content,
      dialogueCount: scriptScene.dialogue_count,
      estimatedPages: scriptScene.estimated_pages,

      // Production data (from production_scene_data)
      location: prodScene?.location || '', // Manual input or from locations DB, not from script
      complexity: prodScene?.complexity || 'medium',
      estimatedShootDays: prodScene?.estimated_shoot_days || 1,
      budget: prodScene?.budget_estimate || 0,
      actualBudget: prodScene?.actual_budget || null,
      shots: prodScene?.shots || [],
      productionNotes: prodScene?.production_notes || '',
      status: prodScene?.status || 'planning',

      // Sync data
      syncStatus: prodScene?.sync_status || 'synced',
      lastSyncedAt: prodScene?.last_synced_at || null,
      lockedAt: prodScene?.locked_at || null,
      lockedBy: prodScene?.locked_by || null,

      // Scheduling
      shootDate: prodScene?.shoot_date ?? null,
      shootDay: prodScene?.shoot_day ?? null,
      callTime: prodScene?.call_time ?? null,
      shootOrder: prodScene?.shoot_order ?? null,

      // Production Location
      productionLocationId: prodScene?.production_location_id || null,

      // Metadata
      createdAt: prodScene?.created_at || null,
      updatedAt: prodScene?.updated_at || null
    });
  }

  return mergedScenes;
}

// Update "Fill with AI" to require synced scenes
router.use('/fill-with-ai', requireSyncedScenes);

// =====================================================
// CHARACTER LINKS ENDPOINT
// =====================================================

/**
 * GET /api/production/character-links/:projectId
 * Get character linking data showing which script characters exist in DB and have cast
 */
router.get('/character-links/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all characters from character database
    const { data: characters, error: charError } = await supabase
      .from('characters')
      .select('id, name, character_type, image_url')
      .eq('project_id', projectId);

    if (charError) {
      console.error('Error fetching characters:', charError);
      return res.status(500).json({ error: 'Failed to fetch characters' });
    }

    // Get all cast members
    const { data: cast, error: castError } = await supabase
      .from('production_cast')
      .select('id, character_name, actor_name, category')
      .eq('project_id', projectId);

    if (castError) {
      console.error('Error fetching cast:', castError);
      return res.status(500).json({ error: 'Failed to fetch cast' });
    }

    // Get script scenes using the parsing service
    let scriptScenes: any[] = [];
    const scriptData = await ScriptParsingService.parseScriptFromProject(projectId, userId);

    if (!scriptData) {
      // If no script exists, continue with empty script characters
      scriptScenes = [];
    } else {
      scriptScenes = scriptData.scenes || [];
    }

    // Extract unique character names from scenes (case-insensitive)
    const scriptCharactersMap = new Map<string, string>(); // uppercase -> original name
    scriptScenes.forEach((scene: any) => {
      if (scene.characters && Array.isArray(scene.characters)) {
        scene.characters.forEach((char: string) => {
          const upperName = char.toUpperCase();
          if (!scriptCharactersMap.has(upperName)) {
            scriptCharactersMap.set(upperName, char); // Store original name
          }
        });
      }
    });

    // Create character map with status (use uppercase keys for case-insensitive matching)
    const characterMap: Record<string, any> = {};

    // Add all script characters
    scriptCharactersMap.forEach((originalName, upperName) => {
      characterMap[upperName] = {
        name: originalName, // Use original name from script for display
        inScript: true,
        inCharacterDB: false,
        hasCast: false,
        characterId: null,
        castId: null,
        actorName: null,
        characterType: null,
        imageUrl: null
      };
    });

    // Mark characters that exist in character DB
    characters?.forEach((char: any) => {
      const upperName = char.name.toUpperCase();
      if (characterMap[upperName]) {
        characterMap[upperName].inCharacterDB = true;
        characterMap[upperName].characterId = char.id;
        characterMap[upperName].characterType = char.character_type;
        characterMap[upperName].imageUrl = char.image_url;
      } else {
        // Character in DB but not in script
        characterMap[upperName] = {
          name: char.name,
          inScript: false,
          inCharacterDB: true,
          hasCast: false,
          characterId: char.id,
          castId: null,
          actorName: null,
          characterType: char.character_type,
          imageUrl: char.image_url
        };
      }
    });

    // Mark characters that have cast assigned
    cast?.forEach((castMember: any) => {
      const upperName = castMember.character_name.toUpperCase();
      if (characterMap[upperName]) {
        characterMap[upperName].hasCast = true;
        characterMap[upperName].castId = castMember.id;
        characterMap[upperName].actorName = castMember.actor_name;
      } else {
        // Cast member for character not in script or character DB
        characterMap[upperName] = {
          name: castMember.character_name,
          inScript: false,
          inCharacterDB: false,
          hasCast: true,
          characterId: null,
          castId: castMember.id,
          actorName: castMember.actor_name,
          characterType: null,
          imageUrl: null
        };
      }
    });

    res.json({
      success: true,
      characters: Object.values(characterMap),
      stats: {
        total: Object.keys(characterMap).length,
        inScript: Object.values(characterMap).filter((c: any) => c.inScript).length,
        inCharacterDB: Object.values(characterMap).filter((c: any) => c.inCharacterDB).length,
        hasCast: Object.values(characterMap).filter((c: any) => c.hasCast).length
      }
    });

  } catch (error) {
    console.error('Error fetching character links:', error);
    res.status(500).json({
      error: 'Failed to fetch character links',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================================
// Production Dashboard
// ============================================================================

async function getScriptSceneCount(projectId: string, userId: string, episodeId?: string): Promise<number> {
  try {
    const parsed = episodeId
      ? await ScriptParsingService.parseScriptFromProject(projectId, userId, undefined, episodeId)
      : await ScriptParsingService.parseScriptFromProject(projectId, userId);

    return parsed?.scenes?.length || 0;
  } catch (error) {
    console.warn('Failed to parse script scenes for production dashboard:', error);
    return 0;
  }
}

// Get production dashboard summary for a project
router.get('/dashboard/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { episode_id } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });

    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) return res.status(403).json({ error: 'Access denied' });

    const episodeId = typeof episode_id === 'string' ? episode_id : undefined;

    // Fetch all data in parallel
    let sceneQuery = supabase
      .from('production_scene_data')
      .select('id, scene_number, status, shoot_date, shoot_day, complexity, budget_estimate')
      .eq('project_id', projectId);

    if (episodeId) sceneQuery = sceneQuery.eq('episode_id', episodeId);

    const [scenesRes, castRes, crewRes, budgetRes, breakdownRes, scriptSceneCount] = await Promise.all([
      sceneQuery,
      supabase.from('production_cast').select('id, character_name').eq('project_id', projectId),
      supabase.from('production_crew').select('id, name').eq('project_id', projectId),
      supabase.from('production_budgets').select('total').eq('project_id', projectId),
      supabase.from('scene_breakdown_items').select('id, scene_data_id').eq('project_id', projectId),
      getScriptSceneCount(projectId, userId, episodeId),
    ]);

    const scenes = scenesRes.data || [];
    const cast = castRes.data || [];
    const crew = crewRes.data || [];
    const budgetItems = budgetRes.data || [];
    const breakdownItems = breakdownRes.data || [];

    // Compute stats
    const totalScenes = Math.max(scenes.length, scriptSceneCount);
    const scenesScheduled = scenes.filter(s => s.shoot_date).length;
    const scenesCompleted = scenes.filter(s => s.status === 'completed').length;

    const shootDates = new Set(scenes.filter(s => s.shoot_date).map(s => s.shoot_date));
    const totalShootDays = shootDates.size;

    const budgetTotal = budgetItems.reduce((sum: number, b: any) => sum + (b.total || 0), 0);

    // Scenes with at least one breakdown item
    const scenesWithBreakdown = new Set(breakdownItems.map((b: any) => b.scene_data_id));
    const breakdownCompleteness = totalScenes > 0
      ? Math.round((scenesWithBreakdown.size / totalScenes) * 100)
      : 0;

    // Next shoot days (upcoming)
    const today = new Date().toISOString().split('T')[0];
    const upcomingDays = [...shootDates]
      .filter(d => d >= today)
      .sort()
      .slice(0, 3)
      .map(date => {
        const dayScenes = scenes.filter(s => s.shoot_date === date);
        return {
          date,
          shootDay: dayScenes[0]?.shoot_day,
          scenesCount: dayScenes.length,
          sceneNumbers: dayScenes.map(s => s.scene_number).sort((a, b) => a - b),
        };
      });

    // Complexity breakdown
    const complexity = {
      simple: scenes.filter(s => s.complexity === 'simple').length,
      medium: scenes.filter(s => s.complexity === 'medium').length,
      complex: scenes.filter(s => s.complexity === 'complex').length,
    };

    res.json({
      totalScenes,
      scenesScheduled,
      scenesCompleted,
      totalShootDays,
      castCount: cast.length,
      crewCount: crew.length,
      budgetTotal,
      breakdownCompleteness,
      upcomingDays,
      complexity,
    });
  } catch (error) {
    console.error('❌ PRODUCTION DASHBOARD ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// ============================================================================
// Production Assets (project-level registry) + Scene Breakdown Items (asset-scene links)
// ============================================================================

// --- ASSETS CRUD (project-level) ---

// Get all assets for a project, optionally filtered by department
router.get('/assets/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { department } = req.query;

    let query = supabase
      .from('production_assets')
      .select('*')
      .eq('project_id', projectId)
      .order('department')
      .order('name');

    if (department) query = query.eq('department', department);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (error) {
    console.error('❌ GET ASSETS ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

// Create asset
router.post('/assets', requireAuth, async (req, res) => {
  try {
    const { project_id, department, name, description, quantity, status, notes } = req.body;
    if (!project_id || !department || !name) {
      return res.status(400).json({ error: 'Missing required fields: project_id, department, name' });
    }

    const userId = getUserId(req);
    const hasAccess = await checkProjectAccessForUser(project_id, userId);
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const { data, error } = await supabase
      .from('production_assets')
      .insert({ project_id, department, name, description, quantity: quantity || 1, status: status || 'needed', notes })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (DEBUG_AI) console.log(`🎬 Asset created: ${name} (${department})`);
    res.status(201).json(data);
  } catch (error) {
    console.error('❌ CREATE ASSET ERROR:', error);
    res.status(500).json({ error: 'Failed to create asset' });
  }
});

// Update asset
router.put('/assets/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, quantity, status, notes } = req.body;

    const { data: asset } = await supabase.from('production_assets').select('project_id').eq('id', id).single();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const userId = getUserId(req);
    const hasAccess = await checkProjectAccessForUser(asset.project_id, userId);
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (quantity !== undefined) updateData.quantity = quantity;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    const { data, error } = await supabase.from('production_assets').update(updateData).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (error) {
    console.error('❌ UPDATE ASSET ERROR:', error);
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// Delete asset (cascades to scene_breakdown_items)
router.delete('/assets/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: asset } = await supabase.from('production_assets').select('project_id').eq('id', id).single();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const userId = getUserId(req);
    const hasAccess = await checkProjectAccessForUser(asset.project_id, userId);
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const { error } = await supabase.from('production_assets').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ DELETE ASSET ERROR:', error);
    res.status(500).json({ error: 'Failed to delete asset' });
  }
});

// --- SCENE BREAKDOWN ITEMS (asset-scene links) ---

// Get assets linked to a scene (with asset details)
router.get('/breakdown-items/:sceneDataId', requireAuth, async (req, res) => {
  try {
    const { sceneDataId } = req.params;
    const { data, error } = await supabase
      .from('scene_breakdown_items')
      .select('*, production_assets(*)')
      .eq('scene_data_id', sceneDataId);

    if (error) {
      console.error('❌ BREAKDOWN ITEMS ERROR:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data || []);
  } catch (error) {
    console.error('❌ GET BREAKDOWN ITEMS ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch breakdown items' });
  }
});

// Link asset to scene
router.post('/breakdown-items', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { scene_data_id, asset_id, project_id, notes } = req.body;
    if (!scene_data_id || !asset_id || !project_id) {
      return res.status(400).json({ error: 'Missing required fields: scene_data_id, asset_id, project_id' });
    }

    // Verify scene_data belongs to this project
    const { data: sceneData, error: sceneError } = await supabase
      .from('production_scene_data')
      .select('project_id')
      .eq('id', scene_data_id)
      .eq('project_id', project_id)
      .single();

    if (sceneError || !sceneData) {
      return res.status(404).json({ error: 'Scene not found in this project' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot add breakdown items', role: access.role });
    }

    const { data, error } = await supabase
      .from('scene_breakdown_items')
      .upsert({ scene_data_id, asset_id, project_id, notes }, { onConflict: 'scene_data_id,asset_id' })
      .select('*, production_assets(*)')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (error) {
    console.error('❌ LINK ASSET TO SCENE ERROR:', error);
    res.status(500).json({ error: 'Failed to link asset to scene' });
  }
});

// Unlink asset from scene
router.delete('/breakdown-items/:id', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;

    // Lookup breakdown item to get scene_data_id and project_id
    const { data: item, error: itemError } = await supabase
      .from('scene_breakdown_items')
      .select('scene_data_id, project_id')
      .eq('id', id)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Breakdown item not found' });
    }

    // Verify scene_data belongs to project
    const { data: sceneData, error: sceneError } = await supabase
      .from('production_scene_data')
      .select('project_id')
      .eq('id', item.scene_data_id)
      .eq('project_id', item.project_id)
      .single();

    if (sceneError || !sceneData) {
      return res.status(404).json({ error: 'Scene not found in this project' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(item.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot remove breakdown items', role: access.role });
    }

    const { error } = await supabase.from('scene_breakdown_items').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ UNLINK ASSET ERROR:', error);
    res.status(500).json({ error: 'Failed to unlink asset from scene' });
  }
});

export default router;
