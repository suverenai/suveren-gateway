import { describe, it, expect } from 'vitest';
import { unsealedPreviews, localPreviewIsUnsealed } from '../components/ProposalArgs';

const display = { approvalView: { imagePath: { label: 'Image file', note: 'not sealed' }, imageUrl: { label: 'Image link', note: 'not sealed' }, text: { label: 'Text' } } };

describe('image previews with a manifest note are not sealed', () => {
  it('local preview goes to the Not sealed block when a present field has a note', () => {
    const args = { text: 'x', imagePath: '/a.png', _imagePreview: 'data:image/png;base64,AAA' };
    expect(localPreviewIsUnsealed(args, display)).toBe(true);
    expect(unsealedPreviews(args, display)).toEqual([{ src: 'data:image/png;base64,AAA', alt: 'image preview', notes: ['not sealed'] }]);
  });
  it('a url image with a note is moved too, once', () => {
    const args = { imageUrl: 'https://x.example/a.png' };
    expect(unsealedPreviews(args, display)).toEqual([{ src: 'https://x.example/a.png', alt: 'image preview', notes: ['not sealed'] }]);
  });
  it('without a note the preview stays where it was', () => {
    const args = { text: 'x', _imagePreview: 'data:image/png;base64,AAA' };
    expect(localPreviewIsUnsealed(args, { approvalView: { text: { label: 'Text' } } })).toBe(false);
    expect(unsealedPreviews(args, { approvalView: { text: { label: 'Text' } } })).toEqual([]);
  });
});
