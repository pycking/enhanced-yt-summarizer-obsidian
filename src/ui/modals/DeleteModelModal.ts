import { App, Modal } from 'obsidian';
import { ModelConfig } from '../../types';
import { SettingsEventHandlers } from '../handlers/SettingsEventHandlers';

export class DeleteModelModal extends Modal {
    constructor(
        app: App,
        private model: ModelConfig,
        private handlers: SettingsEventHandlers
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Delete model' });

        const displayName = this.model.displayName || this.model.name;
        const messageEl = contentEl.createEl('p', {
            text: `Are you sure you want to delete the model "${displayName}"?`
        });
        messageEl.addClass('yt-summarizer-settings__modal-message');

        const buttonContainer = contentEl.createDiv({ cls: 'yt-summarizer-settings__button-container' });

        buttonContainer.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => {
                this.close();
            });

        const deleteButton = buttonContainer.createEl('button', {
            text: 'Delete',
            cls: 'mod-warning'
        });

        deleteButton.addEventListener('click', async () => {
            try {
                await this.handlers.handleModelDelete(this.model);
                this.close();
            } catch (error) {
                console.error('Failed to delete model:', error instanceof Error ? error.message : String(error));
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
} 