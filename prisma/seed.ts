import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { fullPermissionMatrix, SUPER_ADMIN_ROLE } from '../src/lib/permissions';
import { generateTempPassword, hashPassword, validatePassword } from '../src/lib/admin-users';
import { parseEthiopianMobile } from '../src/lib/format';
import { ensureSequences } from '../src/lib/numbering';
import { ROLE_PRESETS } from '../src/lib/role-presets';

/**
 * Bootstrap seed: roles and the first Super Admin. Idempotent — it never
 * overwrites an existing account's password or an edited role.
 *
 * There is no literal fallback password. A supplied SEED_ADMIN_PASSWORD must
 * pass the live password policy; otherwise one is generated and printed once.
 * Either way the account must change it at first sign-in.
 */
async function main() {
  await ensureSequences();

  const superAdmin = await prisma.role.upsert({
    where: { name: SUPER_ADMIN_ROLE },
    create: {
      name: SUPER_ADMIN_ROLE,
      description: 'Full access to everything. Bypasses permission checks.',
      permissions: JSON.stringify(fullPermissionMatrix()),
      isSystem: true,
    },
    update: { permissions: JSON.stringify(fullPermissionMatrix()), isSystem: true },
  });

  for (const preset of ROLE_PRESETS) {
    await prisma.role.upsert({
      where: { name: preset.name },
      create: { name: preset.name, description: preset.description, permissions: JSON.stringify(preset.permissions) },
      update: {},
    });
  }

  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@sme-lending.local').trim().toLowerCase();
  const phone = parseEthiopianMobile(process.env.SEED_ADMIN_PHONE || '0911000000');
  if (!phone) throw new Error('SEED_ADMIN_PHONE must be an Ethiopian mobile number such as 0911000000.');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Super Admin ${email} already exists — left unchanged.`);
  } else {
    const supplied = process.env.SEED_ADMIN_PASSWORD;
    let password: string;
    if (supplied) {
      const policy = validatePassword(supplied);
      if (!policy.ok) throw new Error(`SEED_ADMIN_PASSWORD rejected: ${policy.error}`);
      password = supplied;
    } else {
      password = generateTempPassword();
    }

    await prisma.user.create({
      data: {
        fullName: 'System Administrator',
        email,
        phoneNumber: phone,
        password: await hashPassword(password),
        passwordChangeRequired: true,
        status: 'ACTIVE',
        roleId: superAdmin.id,
      },
    });

    console.log('\n  Super Admin created');
    console.log(`    email:    ${email}`);
    if (!supplied) console.log(`    password: ${password}   (shown once — change it at first sign-in)`);
    console.log('');
  }

  console.log(`Roles: ${[SUPER_ADMIN_ROLE, ...ROLE_PRESETS.map((r) => r.name)].join(', ')}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
