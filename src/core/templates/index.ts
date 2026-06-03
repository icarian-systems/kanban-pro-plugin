/**
 * Public surface of the basic templates module.
 *
 * Free tier. Scripting / dynamic / Templater bridge lives in src/pro/templates.
 */
export type {
  BasicTemplate,
  ExpandedTemplate,
  ExpandContext,
  TemplateStore,
} from './types';
export { expandTemplate } from './expand';
export { createTemplateStore, SEED_TEMPLATES } from './store';
