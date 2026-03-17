import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth';
import { extractUserId, PricingRequest } from '../middleware/pricingMiddleware';
import { z } from 'zod';
import { PricingService } from '../services/pricingService';
import { emailService } from '../services/emailService';
// Note: AddonBillingService has been removed - replaced with unified billing system

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const pricingService = new PricingService(supabase);
// Note: addonBillingService has been removed

const router = express.Router();

// =============================================
// MIDDLEWARE FOR COLLABORATION ACCESS
// =============================================

// Custom middleware for collaboration feature access (Paid plan required)
const requireCollaborationAccess = async (req: PricingRequest, res: Response, next: any) => {
  try {
    const userId = req.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check collaboration access for the user (Paid plan required)
    const pricingService = new PricingService(supabase);
    const hasCollaborationAccess = await pricingService.hasPaidPlan(userId);

    if (!hasCollaborationAccess) {
      return res.status(403).json({
        error: 'Collaboration features require a Pro plan',
        error_type: 'collaboration_blocked_free_plan',
        message: 'Upgrade to Pro to use collaboration features',
        feature: 'collaboration',
        redirect_to: '/projects?view=plans'
      });
    }

    next();
  } catch (error) {
    console.error('❌ Error checking collaboration access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// =============================================
// VALIDATION SCHEMAS
// =============================================

const inviteCollaboratorSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'editor', 'viewer']),
  message: z.string().optional()
});

const updateCollaboratorSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
  permissions: z.object({
    can_edit_content: z.boolean().optional(),
    can_manage_characters: z.boolean().optional(),
    can_manage_locations: z.boolean().optional(),
    can_view_production: z.boolean().optional(),
    can_invite_others: z.boolean().optional(),
    can_manage_project: z.boolean().optional()
  }).optional()
});

const collaborationSessionSchema = z.object({
  document_type: z.enum(['script', 'concept', 'character', 'location', 'document']),
  document_id: z.string().uuid()
});

// =============================================
// HELPER FUNCTIONS
// =============================================

async function checkProjectAccess(userId: string, projectId: string, requiredRole?: string) {

  // First check if user is the project owner
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!projectError && project?.user_id === userId) {
    // Project owner has full access with 'owner' role
    return { hasAccess: true, role: 'owner', permissions: { 
      can_edit_content: true,
      can_manage_characters: true,
      can_manage_locations: true,
      can_view_production: true,
      can_invite_others: true,
      can_manage_project: true
    }};
  }

  // Check if user is a collaborator
  const { data: collaborator, error } = await supabase
    .from('project_collaborators')
    .select('role, status, permissions')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (error || !collaborator) {
    return { hasAccess: false, role: null, permissions: null };
  }

  if (requiredRole) {
    const roleHierarchy = ['viewer', 'editor', 'admin', 'owner'];
    const userRoleIndex = roleHierarchy.indexOf(collaborator.role);
    const requiredRoleIndex = roleHierarchy.indexOf(requiredRole);
    
    if (userRoleIndex < requiredRoleIndex) {
      return { hasAccess: false, role: collaborator.role, permissions: collaborator.permissions };
    }
  }

  return { hasAccess: true, role: collaborator.role, permissions: collaborator.permissions };
}

async function generateInviteToken(): Promise<string> {
  const { randomBytes } = await import('crypto');
  return randomBytes(32).toString('hex');
}

// =============================================
// COLLABORATOR MANAGEMENT
// =============================================

// Get project collaborators
router.get('/projects/:projectId/collaborators', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Check if user has access to this project
    const { hasAccess, role } = await checkProjectAccess(userId, projectId);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Query actual collaborators from the project_collaborators table
    let allCollaborators = [];
    
    try {
      const { data: collaborators, error } = await supabase
        .from('project_collaborators')
        .select(`
          id,
          user_id,
          role,
          status,
          permissions,
          joined_at,
          last_active,
          invited_by,
          invited_at
        `)
        .eq('project_id', projectId)
        .eq('status', 'active')
        .order('joined_at', { ascending: true });

      if (!error && collaborators) {
        allCollaborators = collaborators;
      }
    } catch (queryError) {
      console.error(' Query exception:', queryError);
    }

    // If user is the owner, add them to the list if not already present
    if (role === 'owner') {
      const ownerExists = allCollaborators.some(c => c.user_id === userId);
      if (!ownerExists) {
        
        // Get owner profile info
        const { data: ownerProfile } = await supabase
          .from('users')
          .select('full_name, email, avatar_url')
          .eq('id', userId)
          .single();

        const ownerCollaborator = {
          id: 'owner',
          user_id: userId,
          role: 'owner',
          status: 'active',
          permissions: {
            can_edit_content: true,
            can_manage_characters: true,
            can_manage_locations: true,
            can_view_production: true,
            can_invite_others: true,
            can_manage_project: true
          },
          joined_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          invited_by: null,
          invited_at: null,
          auth: {
            users: {
              email: ownerProfile?.email || '',
              raw_user_meta_data: {
                full_name: ownerProfile?.full_name || ownerProfile?.email?.split('@')[0] || 'Project Owner'
              }
            }
          }
        };

        allCollaborators.unshift(ownerCollaborator); // Add owner at the beginning
      }
    }

    // Get profile information for all collaborators in a single batch query
    const nonOwnerCollaborators = allCollaborators.filter(c => c.id !== 'owner');
    const userIds = nonOwnerCollaborators.map(c => c.user_id);

    const profileMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('users')
        .select('id, email, full_name, avatar_url')
        .in('id', userIds);

      for (const profile of profiles || []) {
        profileMap[profile.id] = profile;
      }
    }

    const collaboratorsWithProfiles = allCollaborators.map(collaborator => {
      if (collaborator.id === 'owner') {
        return collaborator;
      }
      const userInfo = profileMap[collaborator.user_id];
      return {
        ...collaborator,
        auth: {
          users: {
            email: userInfo?.email || '',
            raw_user_meta_data: {
              full_name: userInfo?.full_name || userInfo?.email?.split('@')[0] || 'Unknown User'
            }
          }
        }
      };
    });

    res.json({ collaborators: collaboratorsWithProfiles });
  } catch (error) {
    console.error('Error fetching collaborators:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Invite collaborator
router.post('/projects/:projectId/collaborators/invite', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Validate request body
    const validatedData = inviteCollaboratorSchema.parse(req.body);
    const { email, role, message } = validatedData;

    // Check if user can invite others
    const { hasAccess, permissions } = await checkProjectAccess(userId, projectId, 'editor');
    if (!hasAccess || !permissions?.can_invite_others) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check collaborator limits for project owner (not inviter)
    // ONLY check limits for paid roles (editor/admin), viewers are FREE and UNLIMITED
    if (role === 'editor' || role === 'admin') {
      // Get project to check the owner's subscription
      const { data: projectOwner } = await supabase
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .single();

      if (!projectOwner) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const collaboratorLimitCheck = await pricingService.canPerformAction(projectOwner.user_id, 'add_collaborator');
      if (!collaboratorLimitCheck.allowed) {
        return res.status(403).json({
          error: 'Collaborator limit reached',
          message: collaboratorLimitCheck.reason,
          remaining: collaboratorLimitCheck.remaining
        });
      }
    }

    // Get current user's email to prevent self-invitation
    const { data: currentUserProfile } = await supabase.auth.admin.getUserById(userId);
    const currentUserEmail = currentUserProfile.user?.email;

    if (currentUserEmail && email.toLowerCase() === currentUserEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot invite yourself' });
    }

    // Check if the invitee is already a collaborator (find user by email first)
    const { data: inviteeProfile } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (inviteeProfile) {
      // User exists, check if they're already a collaborator
      const { data: existingCollaborator } = await supabase
        .from('project_collaborators')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', inviteeProfile.id)
        .single();

      if (existingCollaborator) {
        return res.status(400).json({ error: 'User is already a collaborator' });
      }
    }

    // Check for existing active invitation (not declined, not accepted, not expired)
    const { data: existingInvite } = await supabase
      .from('project_invitations')
      .select('id, declined_at, accepted_at, expires_at')
      .eq('project_id', projectId)
      .eq('email', email)
      .single();

    if (existingInvite) {
      const isDeclined = !!existingInvite.declined_at;
      const isAccepted = !!existingInvite.accepted_at;
      const isExpired = new Date(existingInvite.expires_at) < new Date();

      if (!isDeclined && !isAccepted && !isExpired) {
        return res.status(400).json({ error: 'Invitation already sent' });
      }

      // Remove old declined/accepted/expired invitation so we can create a fresh one
      await supabase
        .from('project_invitations')
        .delete()
        .eq('id', existingInvite.id);
    }

    // Generate invitation token
    const token = await generateInviteToken();

    // Create invitation
    const { data: invitation, error } = await supabase
      .from('project_invitations')
      .insert({
        project_id: projectId,
        inviter_id: userId,
        email,
        role,
        token,
        message
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Get project and inviter details for email
    const { data: projectDetails } = await supabase
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .single();

    const { data: inviterInfo } = await supabase
      .from('users')
      .select('full_name, email')
      .eq('id', userId)
      .single();

    // Send invitation email
    const inviteUrl = `${process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173'}/invite/${token}`;

    try {
      await emailService.sendCollaboratorInvitation({
        to: email,
        inviterName: inviterInfo?.full_name || inviterInfo?.email || 'A team member',
        projectName: projectDetails?.name || 'a project',
        role: role,
        inviteUrl: inviteUrl,
        personalMessage: message,
        expiresAt: invitation.expires_at
      });

      // Log activity
      await supabase
        .from('collaboration_activity')
        .insert({
          project_id: projectId,
          user_id: userId,
          activity_type: 'user_invited',
          metadata: { email, role, invitation_id: invitation.id }
        });

      res.json({
        invitation,
        invite_url: inviteUrl,
        message: `Invitation sent successfully! An email has been sent to ${email}.`
      });
    } catch (emailError) {
      console.error('Email sending failed:', emailError);

      // Log activity even if email fails
      await supabase
        .from('collaboration_activity')
        .insert({
          project_id: projectId,
          user_id: userId,
          activity_type: 'user_invited',
          metadata: { email, role, invitation_id: invitation.id, email_failed: true }
        });

      // Still return success since invitation was created
      res.json({
        invitation,
        invite_url: inviteUrl,
        message: 'Invitation created but email could not be sent. Please share the invite URL manually.',
        email_failed: true
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Error inviting collaborator:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's pending invitations
router.get('/user/pending-invitations', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.user.id;

    // Get user's email to match with invitations
    const { data: profile, error: profileError } = await supabase.auth.admin.getUserById(userId);
    
    if (profileError || !profile.user?.email) {
      console.error(' Could not get user profile:', profileError);
      // Return empty invitations instead of error to prevent frontend crashes
      return res.json([]);
    }

    const userEmail = profile.user.email;

    // Get pending invitations for this user's email
    const { data: invitations, error } = await supabase
      .from('project_invitations')
      .select(`
        id,
        token,
        role,
        message,
        created_at,
        expires_at,
        project_id,
        inviter_id,
        projects!inner (
          name,
          description
        )
      `)
      .eq('email', userEmail)
      .is('accepted_at', null)
      .is('declined_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error(' Error fetching pending invitations:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ invitations: invitations || [] });
  } catch (error) {
    console.error('Error getting pending invitations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete/cancel invitation
router.delete('/projects/:projectId/invitations/:invitationId', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId, invitationId } = req.params;
    const userId = req.user.id;

    // Check if user has permission to manage invitations
    const { hasAccess, permissions } = await checkProjectAccess(userId, projectId, 'editor');
    if (!hasAccess || !permissions?.can_invite_others) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete the invitation
    const { error } = await supabase
      .from('project_invitations')
      .delete()
      .eq('id', invitationId)
      .eq('project_id', projectId)
      .is('accepted_at', null)
      .is('declined_at', null);

    if (error) {
      console.error(' Error deleting invitation:', error);
      return res.status(500).json({ error: error.message });
    }

    // Log activity
    await supabase
      .from('collaboration_activity')
      .insert({
        project_id: projectId,
        user_id: userId,
        activity_type: 'invitation_cancelled',
        metadata: { invitation_id: invitationId }
      });

    res.json({ message: 'Invitation cancelled successfully' });
  } catch (error) {
    console.error('Error deleting invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get invitation details (PUBLIC - no auth required so unauthenticated users can view before signing in)
router.get('/invitations/:token/details', async (req: Request, res: Response) => {

  try {
    const { token } = req.params;

    // Get invitation with project and inviter details
    const { data: invitation, error: inviteError } = await supabase
      .from('project_invitations')
      .select(`
        id,
        email,
        role,
        message,
        created_at,
        expires_at,
        project_id,
        inviter_id,
        projects!inner (
          name,
          description
        )
      `)
      .eq('token', token)
      .is('accepted_at', null)
      .is('declined_at', null)
      .single();

    if (inviteError || !invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    // Get inviter details
    const { data: inviter } = await supabase
      .from('users')
      .select('full_name, email')
      .eq('id', invitation.inviter_id)
      .single();

    const responseData = {
      ...invitation,
      project: {
        name: (invitation as any).projects?.name
      },
      inviter: {
        name: inviter?.full_name || inviter?.email?.split('@')[0]
      }
    };

    // Remove the nested projects object since we've flattened it
    delete responseData.projects;

    res.json({ invitation: responseData });
  } catch (error) {
    console.error('Error fetching invitation details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept invitation
router.post('/invitations/:token/accept', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const { token } = req.params;
    const userId = req.user.id;

    // Get invitation
    const { data: invitation, error: inviteError } = await supabase
      .from('project_invitations')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .is('declined_at', null)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (inviteError || !invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    // Check if user email matches invitation
    // Get user email from JWT payload or from user profile
    let userEmail = (req.user as any).email;
    if (!userEmail) {
      // Fallback: get email from user profile
      const { data: profile } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .single();
      userEmail = profile?.email;
    }
    
    if (userEmail !== invitation.email) {
      return res.status(403).json({ error: 'Email mismatch' });
    }

    // Add collaborator
    const { data: collaborator, error: collaboratorError } = await supabase
      .from('project_collaborators')
      .insert({
        project_id: invitation.project_id,
        user_id: userId,
        role: invitation.role,
        status: 'active',
        invited_by: invitation.inviter_id,
        invited_at: invitation.created_at,
        joined_at: new Date().toISOString()
      })
      .select()
      .single();

    if (collaboratorError) {
      return res.status(500).json({ error: collaboratorError.message });
    }

    // Mark invitation as accepted
    await supabase
      .from('project_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invitation.id);

    // Log activity
    await supabase
      .from('collaboration_activity')
      .insert({
        project_id: invitation.project_id,
        user_id: userId,
        activity_type: 'user_joined',
        metadata: { role: invitation.role, invitation_id: invitation.id }
      });

    res.json({ collaborator, project_id: invitation.project_id });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Decline invitation
router.post('/invitations/:token/decline', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const { token } = req.params;
    const userId = req.user.id;

    // Get invitation
    const { data: invitation, error: inviteError } = await supabase
      .from('project_invitations')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .is('declined_at', null)
      .single();

    if (inviteError || !invitation) {
      return res.status(404).json({ error: 'Invalid or already processed invitation' });
    }

    // Verify user email matches
    let userEmail = (req.user as any).email;
    if (!userEmail) {
      const { data: profile } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .single();
      userEmail = profile?.email;
    }

    if (userEmail !== invitation.email) {
      return res.status(403).json({ error: 'Email mismatch' });
    }

    // Mark invitation as declined
    const { error: updateError } = await supabase
      .from('project_invitations')
      .update({ declined_at: new Date().toISOString() })
      .eq('id', invitation.id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error declining invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pending invitations for a project
router.get('/projects/:projectId/invitations', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Check if user has access to this project
    const { hasAccess } = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: invitations, error } = await supabase
      .from('project_invitations')
      .select('id, email, role, created_at, expires_at, message')
      .eq('project_id', projectId)
      .is('accepted_at', null)
      .is('declined_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ invitations });
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update collaborator
router.put('/projects/:projectId/collaborators/:collaboratorId', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId, collaboratorId } = req.params;
    const userId = req.user.id;

    // Validate request body
    const validatedData = updateCollaboratorSchema.parse(req.body);

    // Check if user can manage collaborators
    const { hasAccess } = await checkProjectAccess(userId, projectId, 'admin');
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update collaborator
    const { data: collaborator, error } = await supabase
      .from('project_collaborators')
      .update(validatedData)
      .eq('id', collaboratorId)
      .eq('project_id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Log activity
    await supabase
      .from('collaboration_activity')
      .insert({
        project_id: projectId,
        user_id: userId,
        activity_type: validatedData.role ? 'role_changed' : 'permission_changed',
        metadata: { collaborator_id: collaboratorId, changes: validatedData }
      });

    res.json({ collaborator });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Error updating collaborator:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove collaborator
router.delete('/projects/:projectId/collaborators/:collaboratorId', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId, collaboratorId } = req.params;
    const userId = req.user.id;

    // Check if user can manage collaborators
    const { hasAccess } = await checkProjectAccess(userId, projectId, 'admin');
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get collaborator info before deletion
    const { data: collaborator } = await supabase
      .from('project_collaborators')
      .select('user_id, role')
      .eq('id', collaboratorId)
      .eq('project_id', projectId)
      .single();

    if (!collaborator) {
      return res.status(404).json({ error: 'Collaborator not found' });
    }

    // Prevent removing project owner
    if (collaborator.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove project owner' });
    }

    // Remove collaborator
    const { error } = await supabase
      .from('project_collaborators')
      .delete()
      .eq('id', collaboratorId)
      .eq('project_id', projectId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Log activity
    await supabase
      .from('collaboration_activity')
      .insert({
        project_id: projectId,
        user_id: userId,
        activity_type: 'user_removed',
        metadata: { removed_user_id: collaborator.user_id, role: collaborator.role }
      });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing collaborator:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Leave project (collaborator removes themselves)
router.post('/projects/:projectId/leave', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Find the collaborator record for this user
    const { data: collaborator, error: findError } = await supabase
      .from('project_collaborators')
      .select('id, role')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .single();

    if (findError || !collaborator) {
      return res.status(404).json({ error: 'You are not a collaborator on this project' });
    }

    // Remove the collaborator record
    const { error } = await supabase
      .from('project_collaborators')
      .delete()
      .eq('id', collaborator.id)
      .eq('project_id', projectId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Log activity
    await supabase
      .from('collaboration_activity')
      .insert({
        project_id: projectId,
        user_id: userId,
        activity_type: 'user_left',
        metadata: { role: collaborator.role }
      });

    res.json({ success: true });
  } catch (error) {
    console.error('Error leaving project:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// COLLABORATION SESSIONS
// =============================================

// Start collaboration session
router.post('/projects/:projectId/sessions', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Validate request body
    const validatedData = collaborationSessionSchema.parse(req.body);
    const { document_type, document_id } = validatedData;

    // Check if user has access to this project
    const { hasAccess, permissions } = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if user can edit content
    if (!permissions?.can_edit_content) {
      return res.status(403).json({ error: 'No edit permissions' });
    }

    // Get or create collaboration document
    const { data: existingDoc, error: docError } = await supabase
      .from('collaboration_documents')
      .select('*')
      .eq('project_id', projectId)
      .eq('document_type', document_type)
      .eq('document_id', document_id)
      .single();

    let collaborationDoc;
    if (docError && docError.code === 'PGRST116') {
      // Document doesn't exist, create it
      const { data: newDoc, error: createError } = await supabase
        .from('collaboration_documents')
        .insert({
          project_id: projectId,
          document_type,
          document_id
        })
        .select()
        .single();

      if (createError) {
        return res.status(500).json({ error: createError.message });
      }
      collaborationDoc = newDoc;
    } else if (docError) {
      return res.status(500).json({ error: docError.message });
    } else {
      collaborationDoc = existingDoc;
    }

    // Update user presence
    await supabase
      .from('user_presence')
      .upsert({
        user_id: userId,
        project_id: projectId,
        document_type,
        document_id,
        status: 'online',
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'user_id,project_id'
      });

    res.json({ 
      collaboration_document: collaborationDoc,
      websocket_url: `${process.env.WEBSOCKET_URL}/collaboration/${projectId}/${document_type}/${document_id}` 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Error starting collaboration session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get active collaborators for document
router.get('/projects/:projectId/sessions/:documentType/:documentId/users', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId, documentType, documentId } = req.params;
    const userId = req.user.id;

    // Check if user has access to this project
    const { hasAccess } = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get active users in this document
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: activeUsers, error } = await supabase
      .from('user_presence')
      .select(`
        user_id,
        cursor_position,
        selection_range,
        user_color,
        status,
        last_seen
      `)
      .eq('project_id', projectId)
      .eq('document_type', documentType)
      .eq('document_id', documentId)
      .gt('last_seen', fiveMinutesAgo) // Active in last 5 minutes
      .order('last_seen', { ascending: false });

    if (error) {
      console.error('❌ Error fetching user presence:', error);
      return res.status(500).json({ error: error.message });
    }

    // Get user profiles in a single batch query
    const activeUserIds = (activeUsers || []).map(u => u.user_id);
    const activeProfileMap: Record<string, any> = {};
    if (activeUserIds.length > 0) {
      const { data: profiles } = await supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', activeUserIds);

      for (const profile of profiles || []) {
        activeProfileMap[profile.id] = profile;
      }
    }

    const enrichedActiveUsers = (activeUsers || []).map(user => {
      const profile = activeProfileMap[user.user_id];
      return {
        ...user,
        profile: {
          display_name: profile?.full_name || profile?.email?.split('@')[0] || 'Unknown User',
          email: profile?.email
        }
      };
    });

    res.json({ active_users: enrichedActiveUsers });
  } catch (error) {
    console.error('Error fetching active users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user presence
router.put('/projects/:projectId/presence', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { cursor_position, selection_range, status, document_type, document_id } = req.body;

    // Check if user has access to this project
    const { hasAccess } = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update presence
    const { error } = await supabase
      .from('user_presence')
      .upsert({
        user_id: userId,
        project_id: projectId,
        document_type,
        document_id,
        cursor_position,
        selection_range,
        status,
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'user_id,project_id'
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating presence:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// COLLABORATION ACTIVITY
// =============================================

// Get collaboration activity log
router.get('/projects/:projectId/activity', requireAuth, extractUserId, requireCollaborationAccess, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    // Check if user has access to this project
    const { hasAccess } = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: activities, error } = await supabase
      .from('collaboration_activity')
      .select(`
        id,
        user_id,
        activity_type,
        document_type,
        document_id,
        metadata,
        created_at
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) {
      console.error(' Error fetching collaboration activities:', error);
      return res.status(500).json({ error: error.message });
    }

    // Get unique user IDs and fetch their information
    const userIds = [...new Set(activities?.map(activity => activity.user_id).filter(Boolean))];
    const userProfiles = {};

    if (userIds.length > 0) {
      try {
        // Fetch user info from the public.users table
        const { data: users, error: usersError } = await supabase
          .from('users')
          .select('id, email, full_name, avatar_url')
          .in('id', userIds);

        if (!usersError && users) {
          users.forEach(user => {
            userProfiles[user.id] = {
              id: user.id,
              display_name: user.full_name || user.email?.split('@')[0] || 'Unknown User',
              email: user.email,
              avatar_url: user.avatar_url
            };
          });

        } else {
          console.warn('⚠️ Could not fetch user profiles:', usersError?.message);
          // Fallback to placeholder info
          userIds.forEach(userId => {
            userProfiles[userId] = {
              id: userId,
              display_name: `User ${userId.substring(0, 8)}`,
              email: null,
              avatar_url: null
            };
          });
        }
      } catch (profileFetchError) {
        console.warn('⚠️ Error fetching user profiles:', profileFetchError);
        // Fallback to placeholder info
        userIds.forEach(userId => {
          userProfiles[userId] = {
            id: userId,
            display_name: `User ${userId.substring(0, 8)}`,
            email: null,
            avatar_url: null
          };
        });
      }
    }

    // Enrich activities with user information
    const enrichedActivities = activities?.map(activity => ({
      ...activity,
      user: activity.user_id ? userProfiles[activity.user_id] || null : null
    }));

    res.json({ activities: enrichedActivities });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;