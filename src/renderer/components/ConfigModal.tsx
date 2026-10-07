import { FirstRunWizard } from './FirstRunWizard';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The dialog the app opens when nothing is set up to start a chat with: the
 * two-step first-run wizard.
 *
 * The wizard is mounted only while it is open. Its state is then built anew
 * each time, from what main holds at that moment, and nothing of it runs while
 * the dialog is closed.
 */
export function ConfigModal({ isOpen, onClose }: ConfigModalProps) {
  if (!isOpen) {
    return null;
  }
  return <FirstRunWizard onClose={onClose} />;
}
