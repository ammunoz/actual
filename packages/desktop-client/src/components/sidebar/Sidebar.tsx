import React from 'react';
import { useTranslation } from 'react-i18next';

import { SvgAdd, SvgUpload } from '@actual-app/components/icons/v1';
import { View } from '@actual-app/components/view';

import { useGlobalPref } from '#hooks/useGlobalPref';
import { useNavigate } from '#hooks/useNavigate';
import { replaceModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { Accounts } from './Accounts';
import { BudgetName } from './BudgetName';
import { PrimaryButtons } from './PrimaryButtons';
import { SecondaryButtons } from './SecondaryButtons';
import { useSidebar } from './SidebarProvider';
import { SidebarShell } from './SidebarShell';
import { ToggleButton } from './ToggleButton';

export function Sidebar() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const [isFloating = false, setFloatingSidebarPref] =
    useGlobalPref('floatingSidebar');

  const onFloat = () => {
    setFloatingSidebarPref(!isFloating);
  };

  const onAddAccount = () => {
    dispatch(replaceModal({ modal: { name: 'add-account', options: {} } }));
  };

  return (
    <SidebarShell>
      <BudgetName>
        {!sidebar.alwaysFloats && (
          <ToggleButton isFloating={isFloating} onFloat={onFloat} />
        )}
      </BudgetName>

      <View
        style={{
          flexGrow: 1,
          '@media screen and (max-height: 480px)': {
            overflowY: 'auto',
          },
        }}
      >
        <PrimaryButtons />

        <Accounts />

        <SecondaryButtons
          buttons={[
            {
              title: t('Import'),
              Icon: SvgUpload,
              onClick: () => void navigate('/import'),
              dataTestId: 'sidebar-import',
            },
            {
              title: t('Add account'),
              Icon: SvgAdd,
              onClick: onAddAccount,
              dataTestId: 'sidebar-add-account',
            },
          ]}
        />
      </View>
    </SidebarShell>
  );
}
