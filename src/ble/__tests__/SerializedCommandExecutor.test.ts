import {EMPTY_GRAINFATHER_STATE} from '../../protocol/GrainfatherState';
import {SerializedCommandExecutor} from '../SerializedCommandExecutor';

const command = {
  description: 'turn pump on',
  payload: Uint8Array.from([0x4c, 0x31]),
  confirmationSource: 'Y' as const,
  isConfirmed: (state: typeof EMPTY_GRAINFATHER_STATE) => state.pumpOn === true,
};

describe('SerializedCommandExecutor', () => {
  it('does not attempt a write while disconnected', async () => {
    const write = jest.fn(async () => undefined);
    const executor = new SerializedCommandExecutor(() => false, write, jest.fn());

    await expect(executor.execute(command)).rejects.toThrow('not connected');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a second command while one is pending', async () => {
    const executor = new SerializedCommandExecutor(
      () => true,
      async () => undefined,
      jest.fn(),
    );
    const first = executor.execute(command);

    await expect(executor.execute(command)).rejects.toThrow('already pending');
    executor.cancel('test cleanup');
    await expect(first).rejects.toThrow('test cleanup');
  });

  it('resolves only after matching reported controller state', async () => {
    const statuses = jest.fn();
    const executor = new SerializedCommandExecutor(
      () => true,
      async () => undefined,
      statuses,
    );
    const pending = executor.execute(command);
    executor.observe({...EMPTY_GRAINFATHER_STATE, pumpOn: false}, 'Y');
    expect(statuses).toHaveBeenLastCalledWith(
      expect.objectContaining({state: 'PENDING'}),
    );

    executor.observe({...EMPTY_GRAINFATHER_STATE, pumpOn: true}, 'Y');
    await expect(pending).resolves.toBeUndefined();
    expect(statuses).toHaveBeenLastCalledWith(
      expect.objectContaining({state: 'CONFIRMED'}),
    );
  });
});
