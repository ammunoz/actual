import { describe, expect, it } from 'vitest';

import { actions, reducer } from './modalsSlice';

const { pushModal, removeModal, popModal } = actions;

const review = { name: 'keyboard-import-transactions' } as never;
const merge = { name: 'merge-unused-payees' } as never;

describe('the modal stack', () => {
  it('removes a modal by name, wherever it is', () => {
    // A modal that opens another one and then finishes must close
    // ITSELF: popping the top would close the other one and leave this
    // one on screen.
    let state = reducer(undefined, pushModal({ modal: review }));
    state = reducer(state, pushModal({ modal: merge }));
    expect(state.modalStack).toHaveLength(2);

    state = reducer(
      state,
      removeModal({ name: 'keyboard-import-transactions' }),
    );

    expect(state.modalStack.map(modal => modal.name)).toEqual([
      'merge-unused-payees',
    ]);
  });

  it('leaves the stack alone when the modal is not there', () => {
    let state = reducer(undefined, pushModal({ modal: review }));
    state = reducer(state, removeModal({ name: 'nope' }));
    expect(state.modalStack).toHaveLength(1);
  });

  it('still pops the top modal', () => {
    let state = reducer(undefined, pushModal({ modal: review }));
    state = reducer(state, pushModal({ modal: merge }));
    state = reducer(state, popModal());
    expect(state.modalStack.map(modal => modal.name)).toEqual([
      'keyboard-import-transactions',
    ]);
  });
});
