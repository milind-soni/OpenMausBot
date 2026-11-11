/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentRuns from "../agentRuns.js";
import type * as agentsTables from "../agentsTables.js";
import type * as auth from "../auth.js";
import type * as brandTables from "../brandTables.js";
import type * as broadcastTables from "../broadcastTables.js";
import type * as campaignTables from "../campaignTables.js";
import type * as chiefOpsTables from "../chiefOpsTables.js";
import type * as commits from "../commits.js";
import type * as connectors from "../connectors.js";
import type * as credentials from "../credentials.js";
import type * as crons from "../crons.js";
import type * as design from "../design.js";
import type * as documents from "../documents.js";
import type * as draw from "../draw.js";
import type * as drawTables from "../drawTables.js";
import type * as featureTables from "../featureTables.js";
import type * as feedback from "../feedback.js";
import type * as github from "../github.js";
import type * as githubLifecycleTables from "../githubLifecycleTables.js";
import type * as githubLinks from "../githubLinks.js";
import type * as githubProtection from "../githubProtection.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as integrationTables from "../integrationTables.js";
import type * as integrations from "../integrations.js";
import type * as issueRelations from "../issueRelations.js";
import type * as issueRoutes from "../issueRoutes.js";
import type * as labelTables from "../labelTables.js";
import type * as labels from "../labels.js";
import type * as legacyChat from "../legacyChat.js";
import type * as legacyImport from "../legacyImport.js";
import type * as lib_agentAccess from "../lib/agentAccess.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_chatAccess from "../lib/chatAccess.js";
import type * as lib_columns from "../lib/columns.js";
import type * as lib_completions from "../lib/completions.js";
import type * as lib_features from "../lib/features.js";
import type * as lib_githubAccess from "../lib/githubAccess.js";
import type * as lib_githubApi from "../lib/githubApi.js";
import type * as lib_invitationMail from "../lib/invitationMail.js";
import type * as lib_labels from "../lib/labels.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_projectOrder from "../lib/projectOrder.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_repository from "../lib/repository.js";
import type * as lib_sealing from "../lib/sealing.js";
import type * as lib_storage from "../lib/storage.js";
import type * as lib_storageValidators from "../lib/storageValidators.js";
import type * as lib_taskBranches from "../lib/taskBranches.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_vaultService from "../lib/vaultService.js";
import type * as localStoreImport from "../localStoreImport.js";
import type * as mcp from "../mcp.js";
import type * as mcpOAuth from "../mcpOAuth.js";
import type * as memberProfiles from "../memberProfiles.js";
import type * as members from "../members.js";
import type * as meta from "../meta.js";
import type * as modelHostsTables from "../modelHostsTables.js";
import type * as notifications from "../notifications.js";
import type * as pagesTables from "../pagesTables.js";
import type * as pipelineTables from "../pipelineTables.js";
import type * as planning from "../planning.js";
import type * as preferences from "../preferences.js";
import type * as projectPresence from "../projectPresence.js";
import type * as projects from "../projects.js";
import type * as pulseTables from "../pulseTables.js";
import type * as realtime from "../realtime.js";
import type * as realtimeTables from "../realtimeTables.js";
import type * as serverStore from "../serverStore.js";
import type * as serverStoreTables from "../serverStoreTables.js";
import type * as shipTables from "../shipTables.js";
import type * as standup from "../standup.js";
import type * as standupTables from "../standupTables.js";
import type * as storage from "../storage.js";
import type * as studioTables from "../studioTables.js";
import type * as taskPRs from "../taskPRs.js";
import type * as tasks from "../tasks.js";
import type * as teamGitHub from "../teamGitHub.js";
import type * as teams from "../teams.js";
import type * as wiki from "../wiki.js";
import type * as workspaceCalls from "../workspaceCalls.js";
import type * as workspaceChat from "../workspaceChat.js";
import type * as workspaceDeletion from "../workspaceDeletion.js";
import type * as workspaceSearch from "../workspaceSearch.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentRuns: typeof agentRuns;
  agentsTables: typeof agentsTables;
  auth: typeof auth;
  brandTables: typeof brandTables;
  broadcastTables: typeof broadcastTables;
  campaignTables: typeof campaignTables;
  chiefOpsTables: typeof chiefOpsTables;
  commits: typeof commits;
  connectors: typeof connectors;
  credentials: typeof credentials;
  crons: typeof crons;
  design: typeof design;
  documents: typeof documents;
  draw: typeof draw;
  drawTables: typeof drawTables;
  featureTables: typeof featureTables;
  feedback: typeof feedback;
  github: typeof github;
  githubLifecycleTables: typeof githubLifecycleTables;
  githubLinks: typeof githubLinks;
  githubProtection: typeof githubProtection;
  http: typeof http;
  inbox: typeof inbox;
  integrationTables: typeof integrationTables;
  integrations: typeof integrations;
  issueRelations: typeof issueRelations;
  issueRoutes: typeof issueRoutes;
  labelTables: typeof labelTables;
  labels: typeof labels;
  legacyChat: typeof legacyChat;
  legacyImport: typeof legacyImport;
  "lib/agentAccess": typeof lib_agentAccess;
  "lib/auth": typeof lib_auth;
  "lib/chatAccess": typeof lib_chatAccess;
  "lib/columns": typeof lib_columns;
  "lib/completions": typeof lib_completions;
  "lib/features": typeof lib_features;
  "lib/githubAccess": typeof lib_githubAccess;
  "lib/githubApi": typeof lib_githubApi;
  "lib/invitationMail": typeof lib_invitationMail;
  "lib/labels": typeof lib_labels;
  "lib/permissions": typeof lib_permissions;
  "lib/projectOrder": typeof lib_projectOrder;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/repository": typeof lib_repository;
  "lib/sealing": typeof lib_sealing;
  "lib/storage": typeof lib_storage;
  "lib/storageValidators": typeof lib_storageValidators;
  "lib/taskBranches": typeof lib_taskBranches;
  "lib/validators": typeof lib_validators;
  "lib/vaultService": typeof lib_vaultService;
  localStoreImport: typeof localStoreImport;
  mcp: typeof mcp;
  mcpOAuth: typeof mcpOAuth;
  memberProfiles: typeof memberProfiles;
  members: typeof members;
  meta: typeof meta;
  modelHostsTables: typeof modelHostsTables;
  notifications: typeof notifications;
  pagesTables: typeof pagesTables;
  pipelineTables: typeof pipelineTables;
  planning: typeof planning;
  preferences: typeof preferences;
  projectPresence: typeof projectPresence;
  projects: typeof projects;
  pulseTables: typeof pulseTables;
  realtime: typeof realtime;
  realtimeTables: typeof realtimeTables;
  serverStore: typeof serverStore;
  serverStoreTables: typeof serverStoreTables;
  shipTables: typeof shipTables;
  standup: typeof standup;
  standupTables: typeof standupTables;
  storage: typeof storage;
  studioTables: typeof studioTables;
  taskPRs: typeof taskPRs;
  tasks: typeof tasks;
  teamGitHub: typeof teamGitHub;
  teams: typeof teams;
  wiki: typeof wiki;
  workspaceCalls: typeof workspaceCalls;
  workspaceChat: typeof workspaceChat;
  workspaceDeletion: typeof workspaceDeletion;
  workspaceSearch: typeof workspaceSearch;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
