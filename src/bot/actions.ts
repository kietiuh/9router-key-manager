export const BOT_ACTIONS = {
  HOME: 'home',
  QUOTA: 'quota',
  KEY: 'key',
  KEY_CHANGE: 'key_change',
  HISTORY: 'history',
  SETTINGS: 'settings',
  ALERTS_ON: 'alerts_on',
  ALERTS_OFF: 'alerts_off',
  THRESHOLD_20: 'threshold_20',
  THRESHOLD_10: 'threshold_10',
  THRESHOLD_5: 'threshold_5',
  THRESHOLD_CUSTOM: 'threshold_custom',
  HELP: 'help',
  CANCEL: 'cancel',
} as const;

export type BotAction = typeof BOT_ACTIONS[keyof typeof BOT_ACTIONS];

const actionCommandMap = new Map<BotAction, string>([
  [BOT_ACTIONS.HOME, '/start'],
  [BOT_ACTIONS.QUOTA, '/quota'],
  [BOT_ACTIONS.KEY, '/key'],
  [BOT_ACTIONS.KEY_CHANGE, '/key_change'],
  [BOT_ACTIONS.HISTORY, '/history'],
  [BOT_ACTIONS.SETTINGS, '/settings'],
  [BOT_ACTIONS.ALERTS_ON, '/alerts_on'],
  [BOT_ACTIONS.ALERTS_OFF, '/alerts_off'],
  [BOT_ACTIONS.THRESHOLD_20, '/threshold_20'],
  [BOT_ACTIONS.THRESHOLD_10, '/threshold_10'],
  [BOT_ACTIONS.THRESHOLD_5, '/threshold_5'],
  [BOT_ACTIONS.THRESHOLD_CUSTOM, '/threshold_custom'],
  [BOT_ACTIONS.HELP, '/help'],
  [BOT_ACTIONS.CANCEL, '/cancel'],
]);

export function commandForAction(action: string): string | null {
  return actionCommandMap.get(action as BotAction) ?? null;
}
