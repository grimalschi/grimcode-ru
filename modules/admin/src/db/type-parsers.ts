import pg from 'pg';

/** Calendar dates and zoneless timestamps stay as stored; timestamptz keeps the driver's Date. */
export function typeParsers(): { getTypeParser: (oid: number, format?: unknown) => unknown } {
  return {
    getTypeParser(oid, format) {
      if (oid === 1082 || oid === 1114) return (value: string) => value;
      return pg.types.getTypeParser(oid, format as never);
    },
  };
}
