export function redactOperation<T extends Record<string, unknown>>(operation: T, canSeeSensitiveIds: boolean): T {
  if (canSeeSensitiveIds) {
    return operation;
  }

  return {
    ...operation,
    id: null,
    operation_id: null,
    server_key: null,
    mission_uid: null,
    raw_start_payload: undefined,
    raw_end_payload: undefined
  };
}

export function redactOperationListItem<T extends Record<string, unknown>>(operation: T, canSeeSensitiveIds: boolean): T {
  if (canSeeSensitiveIds) {
    return operation;
  }

  return {
    ...operation,
    server_key: null,
    mission_uid: null
  };
}

export function redactPlayer<T extends Record<string, unknown>>(player: T, canSeeSensitiveIds: boolean): T {
  if (canSeeSensitiveIds) {
    return player;
  }

  return {
    ...player,
    player_uid: null,
    raw_last_player: undefined
  };
}

export function redactAttendance<T extends Record<string, unknown>>(row: T, canSeeSensitiveIds: boolean): T {
  if (canSeeSensitiveIds) {
    return row;
  }

  return {
    ...row,
    player_uid: null,
    stats_player_uid: null
  };
}

export function redactIngestRequest<T extends Record<string, unknown>>(row: T, canSeeSensitiveIds: boolean): T {
  if (canSeeSensitiveIds) {
    return row;
  }

  return {
    ...row,
    request_id: null,
    operation_id: null,
    payload: undefined,
    response: undefined
  };
}

export function tokenPreview(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
