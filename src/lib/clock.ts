export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now() {
    return new Date();
  },
};
